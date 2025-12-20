// --- 1. Load our tools ---
const express = require('express');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer'); // For file uploads
const fetch = require('node-fetch'); // Make sure to install: npm install node-fetch
// Local image recognition fallback
let tf = null;
let mobilenet = null;
let cocoSsd = null;

// --- 2. Initialize the server and clients ---
const app = express();
const PORT = 3000;
console.log("Starting server setup...");

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("FATAL ERROR: Supabase URL or Key is missing.");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized.");

// Initialize Google AI
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.warn("WARNING: Gemini API Key is missing. AI features will not work.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

// A single, multimodal model for both text and vision tasks.
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-002" });
console.log("Google AI multimodal model (gemini-1.5-flash-002) initialized.");

// Optional: toggle verbose error logs from AI via env flag
const DEBUG_LOGS = process.env.DEBUG_LOGS === 'true';

// Lazy-load TensorFlow/MobileNet on first use to reduce startup time
async function ensureLocalClassifierLoaded() {
    if (!tf) {
        tf = require('@tensorflow/tfjs-node');
    }
    if (!mobilenet) {
        mobilenet = require('@tensorflow-models/mobilenet');
    }
    if (!cocoSsd) {
        cocoSsd = require('@tensorflow-models/coco-ssd');
    }
    if (!global.__loadedMobileNetModel) {
        // Load a reasonably fast variant
        global.__loadedMobileNetModel = await mobilenet.load({ version: 2, alpha: 1.0 });
    }
    if (!global.__loadedCocoModel) {
        global.__loadedCocoModel = await cocoSsd.load();
    }
    return { mobileNetModel: global.__loadedMobileNetModel, cocoModel: global.__loadedCocoModel };
}

// Initialize Multer for in-memory file storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware to parse JSON bodies
app.use(express.json());

// --- 3. Reusable Helper Functions ---

async function getOrSimulateExternalPrice(productName) {
    console.log(`Getting external price for: ${productName}`);
    
    // --- SIMULATION (PLACEHOLDER) ---
    const basePrices = {
        'burger': 150,
        'pizza': 300,
        'samosa': 20,
    };
    const basePrice = basePrices[productName.toLowerCase()] || 100; // Default price
    const simulatedPrice = (basePrice + (Math.random() - 0.5) * 20).toFixed(2); // Add/subtract up to 10
    
    return Promise.resolve({ 
        price: parseFloat(simulatedPrice), 
        source: 'Simulated External Market' 
    });
}

async function findProducts(query, latitude, longitude) {
    console.log(`findProducts: Searching for "${query}" near ${latitude}, ${longitude}`);

    // 1. Find nearby shops
    const { data: shops, error: shopsError } = await supabase.rpc('nearby_shops', {
        lat: latitude,
        long: longitude
    });
    if (shopsError) throw shopsError;

    if (!shops || shops.length === 0) {
        return { summary: "No shops found near your location.", recommendations: [] };
    }
    console.log(`findProducts: Found ${shops.length} shops.`);

    // 2. Get products from those shops
    const shopIds = shops.map(shop => shop.id);
    let productsQuery = supabase
        .from('products')
        .select('*, shops (name, contact_number, email, latitude, longitude)') // Fetches shop details
        .in('shop_id', shopIds);
    if (query && String(query).trim().length > 0) {
        productsQuery = productsQuery.ilike('name', `%${query}%`); // Case-insensitive search
    }
    const { data: products, error: productsError } = await productsQuery;
    
    if (productsError) throw productsError;

    if (!products || products.length === 0) {
        const q = query && String(query).trim().length > 0 ? `matching "${query}" ` : '';
        return { summary: `No products ${q}found in nearby shops.`, recommendations: [] };
    }
    console.log(`findProducts: Found ${products.length} products matching query.`);

    // 3. Prepare data for AI and local ranking
    const contextForAI = products.map(p => ({
        product_name: p.name,
        price: p.price,
        rating: p.rating,
        shop_name: p.shops ? p.shops.name : 'Unknown Shop',
        contact_number: p.shops ? p.shops.contact_number : null,
        email: p.shops ? p.shops.email : null,
        shop_id: p.shop_id,
        shop_latitude: p.shops ? p.shops.latitude : null,
        shop_longitude: p.shops ? p.shops.longitude : null
    }));

    // 4. Create the prompt for the AI
    const prompt = `
        You are an expert shopping assistant. Your task is to analyze a list of products found near a user and recommend the best options. The user is searching for "${query}".

        Here is the list of available products:
        ${JSON.stringify(contextForAI)}

        Analyze the list and provide a helpful summary. Then, identify the top 3 best options.
        Rank them by the BEST combination of LOW price and HIGH rating. For each of the top 3 recommendations, explain briefly why it is a good choice.

        Respond ONLY with a valid JSON object in the following format. Do not include any other text or markdown formatting.
        {
          "summary": "Your overall analysis here. Be friendly and helpful.",
          "recommendations": [
            {
              "rank": 1,
              "product_name": "Product Name",
              "price": 199.50,
              "rating": 4.8,
              "shop_name": "Shop Name",
              "shop_contact_number": "9876543210",
              "shop_email": "info@shop.com",
              "reason": "Brief reason for recommendation."
            }
          ]
        }
    `;

    // 5. Decide strategy: AI vs deterministic
    const USE_LOCAL_RANKING = process.env.USE_LOCAL_RANKING === 'true';
    if (!USE_LOCAL_RANKING) {
        try {
            console.log("findProducts: Calling Gemini API...");
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
            return JSON.parse(cleanedText);
        } catch (aiError) {
            console.warn("findProducts: AI unavailable, using deterministic ranking.");
            if (DEBUG_LOGS) console.error(aiError);
        }
    }

    // Deterministic ranking: nearest, then cheapest, then highest rating
    const toRad = (v) => (v * Math.PI) / 180;
    const distanceKm = (lat1, lon1, lat2, lon2) => {
        if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Number.POSITIVE_INFINITY;
        const R = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    };

    const safeNumber = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const enriched = products.map(p => {
        const dist = distanceKm(latitude, longitude, p.shops ? p.shops.latitude : null, p.shops ? p.shops.longitude : null);
        return {
            product_name: p.name,
            price: safeNumber(p.price, Number.POSITIVE_INFINITY),
            rating: safeNumber(p.rating, 0),
            shop_name: p.shops ? p.shops.name : 'Unknown Shop',
            shop_contact_number: p.shops ? p.shops.contact_number : null,
            shop_email: p.shops ? p.shops.email : null,
            distance_km: dist
        };
    });

    const ranked = enriched
        .sort((a, b) => {
            const byDistance = a.distance_km - b.distance_km;
            if (byDistance !== 0) return byDistance;
            const byPrice = a.price - b.price;
            if (byPrice !== 0) return byPrice;
            return b.rating - a.rating;
        })
        .slice(0, 3)
        .map((item, idx) => ({
            rank: idx + 1,
            product_name: item.product_name,
            price: item.price === Number.POSITIVE_INFINITY ? null : item.price,
            rating: item.rating,
            shop_name: item.shop_name,
            shop_contact_number: item.shop_contact_number,
            shop_email: item.shop_email,
            distance_km: Number.isFinite(item.distance_km) ? Number(item.distance_km.toFixed(2)) : null,
            reason: 'Ranked by distance, then price, then rating.'
        }));

    const summary = `Top ${ranked.length} results for "${query}" near you based on distance, price, and rating.`;
    return { summary, recommendations: ranked };
}


// --- 4. API Endpoints ---

// Base route
app.get('/', (req, res) => {
    res.json({ message: "Success! Your Smart Shop backend is running." });
});

// Lightweight health and environment check
app.get('/health', async (req, res) => {
    try {
        const supabaseOk = !!supabase;
        const aiConfigured = !!geminiApiKey;
        res.json({
            ok: true,
            supabase: supabaseOk,
            aiConfigured,
            model: 'gemini-1.5-flash'
        });
    } catch (_) {
        res.status(500).json({ ok: false });
    }
});

// --- (Authentication Endpoints) ---

app.post('/auth/signup', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        const { data, error } = await supabase.auth.signUp({
            email, password, options: { data: { full_name: full_name } }
        });
        if (error) throw error;
        res.status(201).json({ user: data.user, message: 'Signup successful! Trigger will create profile.' });
    } catch (error) {
        console.error("Signup Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        res.json({ session: data.session, user: data.user });
    } catch (error) {
        console.error("Login Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

// --- (Middleware to Protect Routes) ---

const protectRoute = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header is missing or malformed.' });
        }
        const token = authHeader.split(' ')[1];
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid or expired token.' });
        }
        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Authentication failed.' });
    }
};

// --- (Shop & Product Endpoints) ---

app.post('/shops', protectRoute, async (req, res) => {
    try {
        const { 
            name, 
            description, 
            latitude, 
            longitude, 
            contact_number = null,
            email = null 
        } = req.body;
        
        const owner_id = req.user.id;

        if (!name || !latitude || !longitude) {
             return res.status(400).json({ error: 'Name, latitude, and longitude are required.' });
        }

        const { data, error } = await supabase
            .from('shops')
            .insert({ name, description, owner_id, latitude, longitude, contact_number, email })
            .select()
            .single();
            
        if (error) throw error;
        res.status(201).json(data);
    } catch (error) {
        console.error("Create Shop Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

app.get('/shops', async (req, res) => {
    try {
        const { data, error } = await supabase.from('shops').select('*');
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/products', protectRoute, async (req, res) => {
    try {
        const { name, description, price, shop_id, rating = 3.0 } = req.body;
        const { data, error } = await supabase
            .from('products')
            .insert({ name, description, price, shop_id, rating })
            .select()
            .single();
        if (error) throw error;
        res.status(201).json(data);
    } catch (error) {
        console.error("Add Product Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

app.get('/products', async (req, res) => {
    try {
        let query = supabase.from('products').select('*, shops (name, contact_number, email)');
        if (req.query.shop_id) {
            query = query.eq('shop_id', req.query.shop_id);
        }
        const { data, error } = await query;
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- (AI Feature Endpoints) ---

/**
 * FEATURE 1: AI Text Search
 */
app.post('/ai/search', async (req, res) => {
    try {
        console.log("\n--- AI Text Search: Received New Request ---", req.body);
        const { query, latitude, longitude } = req.body;
        if (!query || !latitude || !longitude) {
            return res.status(400).json({ error: 'Query, latitude, and longitude are required.' });
        }

        const results = await findProducts(query, latitude, longitude);
        res.json(results);

    } catch (error) {
        console.error("\n--- !!! FULL AI SEARCH ERROR !!! ---");
        console.error(error);
        if (error instanceof SyntaxError && error.message.includes('JSON')) {
             return res.status(500).json({ error: 'The AI returned a response that was not valid JSON.' });
        }
        res.status(500).json({ error: 'An internal error occurred.' });
    }
});

/**
 * FEATURE 2: AI Image Search
 */
app.post('/ai/search-by-image', upload.single('foodImage'), async (req, res) => {
    try {
        console.log("\n--- AI Image Search: Received New Request ---");
        
        const { latitude, longitude } = req.body;
        const imageFile = req.file;

        if (!imageFile) {
            return res.status(400).json({ error: 'Image file (as "foodImage") is required.' });
        }
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'latitude and longitude are required.' });
        }

        // 2. Prepare image for Gemini Vision
        const imagePart = {
            inlineData: {
                data: imageFile.buffer.toString("base64"),
                mimeType: imageFile.mimetype
            }
        };
        
        const prompt = "Identify the food in this image. Respond with ONLY the name of the food (e.g., 'Burger', 'Pizza', 'Samosa'). Do not add any other text.";

        // 3. Try Gemini, else graceful fallbacks
        let identifiedFood = null;
        let classifierPredictions = [];
        if (!geminiApiKey) {
            console.warn("AI Image Search: GEMINI_API_KEY missing; skipping AI and using fallback.");
        } else {
            try {
                console.log("AI Image Search: Identifying image...");
                const result = await model.generateContent([prompt, imagePart]);
                const response = await result.response;
                identifiedFood = (response.text() || '').trim();
                console.log(`AI Image Search: Identified food as: ${identifiedFood}`);
            } catch (aiErr) {
                console.warn("AI Image Search: AI unavailable, trying local classifier fallback.");
                if (DEBUG_LOGS) console.error(aiErr);
            }
        }

        // Fallback 1: On-device MobileNet classifier
        if (!identifiedFood) {
            try {
                const { mobileNetModel, cocoModel } = await ensureLocalClassifierLoaded();
                // Decode image buffer and classify top predictions
                const decoded = tf.node.decodeImage(imageFile.buffer, 3);
                const predictions = await mobileNetModel.classify(decoded, 5);
                decoded.dispose();
                classifierPredictions = (predictions || []).map(p => ({ className: p.className, probability: p.probability }));

                // Map general labels to expanded food categories
                const mapLabelToQuery = (text) => {
                    const t = (text || '').toLowerCase();
                    if (t.includes('burger') || t.includes('cheeseburger')) return 'Burger';
                    if (t.includes('pizza')) return 'Pizza';
                    if (t.includes('samosa')) return 'Samosa';
                    if (t.includes('cake') || t.includes('cupcake') || t.includes('pastry')) return 'Cake';
                    if (t.includes('sandwich') || t.includes('submarine')) return 'Sandwich';
                    if (t.includes('donut') || t.includes('doughnut')) return 'Donut';
                    if (t.includes('noodle') || t.includes('pasta') || t.includes('spaghetti')) return 'Pasta';
                    if (t.includes('biryani') || t.includes('rice')) return 'Biryani';
                    if (t.includes('dosa')) return 'Dosa';
                    if (t.includes('idli')) return 'Idli';
                    if (t.includes('vada') || t.includes('vadai')) return 'Vada';
                    if (t.includes('roll') || t.includes('wrap')) return 'Roll';
                    if (t.includes('muffin') || t.includes('cookie') || t.includes('biscuit')) return 'Cake';
                    if (t.includes('ice cream') || t.includes('ice-cream')) return 'Ice Cream';
                    if (t.includes('coffee')) return 'Coffee';
                    if (t.includes('tea')) return 'Tea';
                    if (t.includes('juice')) return 'Juice';
                    return null;
                };

                const top = (predictions && predictions[0] && predictions[0].className) ? predictions[0].className : '';
                identifiedFood = mapLabelToQuery(top);
                if (!identifiedFood) {
                    for (const p of (predictions || [])) {
                        const guess = mapLabelToQuery(p.className);
                        if (guess) { identifiedFood = guess; break; }
                    }
                }
                // If still not identified, attempt COCO-SSD object detection
                if (!identifiedFood) {
                    const decoded2 = tf.node.decodeImage(imageFile.buffer, 3);
                    const detections = await cocoModel.detect(decoded2);
                    decoded2.dispose();
                    const cocoToQuery = (name) => {
                        const t = (name || '').toLowerCase();
                        if (t.includes('cake')) return 'Cake';
                        if (t.includes('pizza')) return 'Pizza';
                        if (t.includes('donut') || t.includes('doughnut')) return 'Donut';
                        if (t.includes('sandwich')) return 'Sandwich';
                        if (t.includes('hot dog')) return 'Burger'; // approximate to fast food
                        if (t.includes('banana') || t.includes('apple') || t.includes('orange')) return 'Fruit';
                        return null;
                    };
                    for (const d of (detections || [])) {
                        if (typeof d.score === 'number' && d.score < 0.3) continue;
                        const guess = cocoToQuery(d.class);
                        if (guess) { identifiedFood = guess; break; }
                    }
                }
                // If still not mapped, take the top MobileNet class token as detected label (for UX visibility)
                if (!identifiedFood && predictions && predictions.length > 0) {
                    identifiedFood = predictions[0].className.split(',')[0].trim();
                }
                console.log(`AI Image Search: Local classifier guess: ${identifiedFood || 'unknown'}`);
            } catch (localErr) {
                console.warn('AI Image Search: Local classifier failed, will use deterministic fallback.');
                if (DEBUG_LOGS) console.error(localErr);
            }
        }

        // Fallback 2: If still unknown, do NOT force a name filter; let ranking handle it
        const searchTerm = identifiedFood || '';

        // 4. Call the reusable findProducts function (which itself has fallback)
        const searchResults = await findProducts(searchTerm, latitude, longitude);

        // 5. Return the results with detection context
        res.json({
            detected_label: identifiedFood || null,
            predictions: classifierPredictions,
            ...searchResults
        });

    } catch (error) {
        console.warn("\nAI Image Search: Unexpected error; returning safe fallback.");
        if (DEBUG_LOGS) console.error(error);
        try {
            const safeQuery = 'Burger';
            const searchResults = await findProducts(safeQuery, req.body.latitude, req.body.longitude);
            return res.json(searchResults);
        } catch (fallbackErr) {
            if (DEBUG_LOGS) console.error(fallbackErr);
            return res.status(500).json({ error: 'An internal error occurred during image search.' });
        }
    }
});

// --- (MARKET TREND ENDPOINTS) ---

/**
 * FEATURE 3: Add Market Price Data
 */
app.post('/market-price', protectRoute, async (req, res) => {
    try {
        const { product_name, price, source = 'Internal' } = req.body;
        if (!product_name || !price) {
            return res.status(400).json({ error: 'product_name and price are required.' });
        }

        const { data, error } = await supabase
            .from('market_price')
            .insert({ product_name, price, source });

        if (error) throw error;
        res.status(201).json({ message: 'Market price added successfully', data: data });

    } catch (error) {
        console.error("\n--- !!! ADD MARKET PRICE ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred.' });
    }
});


/**
 * FEATURE 4: AI Market Trend Prediction
 */
app.get('/ai/market-trend/:productName', async (req, res) => {
    try {
        const { productName } = req.params;
        console.log(`\n--- AI Market Trend: Received Request for ${productName} ---`);

        // 1. Get internal data from your 'market_price' table
        const { data: prices, error: dbError } = await supabase
            .from('market_price')
            .select('price, created_at')
            .ilike('product_name', productName)
            .order('created_at', { ascending: false })
            .limit(30);

        if (dbError) throw dbError;

        // 2. Analyze internal trend
        let internalTrend = "Insufficient Data";
        let internalPrice = null;
        if (prices && prices.length > 0) {
            internalPrice = prices[0].price; // Most recent price
            if (prices.length > 1) {
                const latestPrice = prices[0].price;
                const olderPrices = prices.slice(1);
                const avgOldPrice = olderPrices.reduce((acc, p) => acc + p.price, 0) / olderPrices.length;
                
                if (latestPrice > avgOldPrice * 1.05) { // 5% increase
                    internalTrend = "Rising";
                } else if (latestPrice < avgOldPrice * 0.95) { // 5% decrease
                    internalTrend = "Falling";
                } else {
                    internalTrend = "Stable";
                }
            }
        }
        console.log(`AI Market Trend: Internal trend is ${internalTrend}`);

        // 3. Get external data (from our new helper function)
        const externalData = await getOrSimulateExternalPrice(productName);
        console.log(`AI Market Trend: External data is ${externalData.price} from ${externalData.source}`);

        // 4. Ask AI for a prediction
        const prompt = `
            You are a market analyst. The user wants to know the trend for "${productName}".
            
            Here is the data:
            - Our internal price (most recent): ${internalPrice ? `$${internalPrice}` : 'N/A'}
            - Our internal trend (last 30 entries): ${internalTrend}
            - Current external market price: $${externalData.price} (Source: ${externalData.source})

            Based *only* on this data, provide a simple prediction: "BUY" (price is low/rising), "SELL" (price is high/falling), or "HOLD" (price is stable).
            Provide a brief, one-sentence reason for your choice.

            Respond ONLY with a valid JSON object in the following format:
            {
              "prediction": "BUY",
              "reason": "Your brief analysis here.",
              "internal_price": ${internalPrice || null},
              "external_price": ${externalData.price}
            }
        `;
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        res.json(JSON.parse(text));

    } catch (error) {
        console.warn("\nAI market trend: AI unavailable, using rule-based fallback.");
        if (DEBUG_LOGS) console.error(error);
        // Graceful fallback: derive a deterministic recommendation from internal/external data
        try {
            const { productName } = req.params;
            const { data: prices } = await supabase
                .from('market_price')
                .select('price, created_at')
                .ilike('product_name', productName)
                .order('created_at', { ascending: false })
                .limit(30);

            let internalTrend = "Insufficient Data";
            let internalPrice = null;
            if (prices && prices.length > 0) {
                internalPrice = prices[0].price;
                if (prices.length > 1) {
                    const latestPrice = prices[0].price;
                    const olderPrices = prices.slice(1);
                    const avgOldPrice = olderPrices.reduce((acc, p) => acc + p.price, 0) / olderPrices.length;
                    if (latestPrice > avgOldPrice * 1.05) internalTrend = "Rising";
                    else if (latestPrice < avgOldPrice * 0.95) internalTrend = "Falling";
                    else internalTrend = "Stable";
                }
            }

            const externalData = await getOrSimulateExternalPrice(productName);
            // Simple rule-based fallback
            let prediction = "HOLD";
            let reason = "Prices appear stable based on recent internal data.";
            if (internalTrend === "Rising" && internalPrice && internalPrice < externalData.price) {
                prediction = "BUY";
                reason = "Internal price trending up and below external market.";
            } else if (internalTrend === "Falling" && internalPrice && internalPrice > externalData.price) {
                prediction = "SELL";
                reason = "Internal price trending down and above external market.";
            }

            return res.json({
                prediction,
                reason,
                internal_price: internalPrice,
                external_price: externalData.price
            });
        } catch (fallbackErr) {
            if (error instanceof SyntaxError && error.message.includes('JSON')) {
                return res.status(500).json({ error: 'The AI returned a response that was not valid JSON.' });
            }
            return res.status(500).json({ error: 'An internal error occurred during trend analysis.' });
        }
    }
});


// --- 5. Start the server ---
app.listen(PORT, () => {
    console.log(`Server is successfully running on http://localhost:${PORT}`);
});