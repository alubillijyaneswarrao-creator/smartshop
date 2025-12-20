// --- 1. Load our tools ---
const express = require('express');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer'); // For file uploads
const fetch = require('node-fetch'); // Make sure to install: npm install node-fetch

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
// The correct way
const model = genAI.getGenerativeModel({ model: "gemini-pro" });
console.log("Google AI client initialized.");

// Initialize Multer for in-memory file storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware to parse JSON bodies
app.use(express.json());

// --- 3. Reusable Helper Functions ---

/**
 * NEW HELPER FUNCTION
 * In a real app, you would call an external API.
 * For now, this simulates it to make the feature work.
 */
async function getOrSimulateExternalPrice(productName) {
    console.log(`Getting external price for: ${productName}`);
    
    // --- REAL API (EXAMPLE) ---
    // If you had a real API, you would do this:
    // try {
    //   const response = await fetch(`https://api.someprice.com/v1/price?item=${productName}&key=YOUR_API_KEY`);
    //   const data = await response.json();
    //   return { price: data.price, source: 'RealMarket API' };
    // } catch (error) {
    //   console.error("External API failed, falling back to simulation.");
    // }

    // --- SIMULATION (PLACEHOLDER) ---
    // Since we don't have a real API, we'll simulate a response.
    // This creates a slightly random price for demonstration.
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
// Inside an async function
async function getAIResponse(productInfo) {
  try {
    // 1. Create your prompt
    const prompt = `Based on these products: ${JSON.stringify(productInfo)}, which is the best option?`;

    // 2. Call the model
    const result = await model.generateContent(prompt);
    const response = await result.response;

    // 3. Get the text response
    const text = response.text();
    console.log(text);
    return text;

  } catch (error) {
    console.error("Error calling Gemini API:", error);
  }
}

/**
 * This function finds products based on a text query and location.
 */
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
    const { data: products, error: productsError } = await supabase
        .from('products')
        .select('*, shops (name, contact_number, email)') // Fetches shop details
        .in('shop_id', shopIds)
        .ilike('name', `%${query}%`); // Case-insensitive search
    
    if (productsError) throw productsError;

    if (!products || products.length === 0) {
        return { summary: `No products matching "${query}" found in nearby shops.`, recommendations: [] };
    }
    console.log(`findProducts: Found ${products.length} products matching query.`);

    // 3. Prepare data for AI
    const contextForAI = products.map(p => ({
        product_name: p.name,
        price: p.price,
        rating: p.rating,
        shop_name: p.shops ? p.shops.name : 'Unknown Shop',
        contact_number: p.shops ? p.shops.contact_number : null,
        email: p.shops ? p.shops.email : null,
        shop_id: p.shop_id
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

    // 5. Call the AI and get the response
    console.log("findProducts: Calling Gemini API...");
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // 6. Clean and parse the JSON response
    const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanedText);
}


// --- 4. API Endpoints ---

// Base route
app.get('/', (req, res) => {
    res.json({ message: "Success! Your Smart Shop backend is running." });
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

// *** THIS ENDPOINT IS FIXED ***
// It now safely handles missing email/contact_number
app.post('/shops', protectRoute, async (req, res) => {
    try {
        // Use default 'null' if a field is not provided
        const { 
            name, 
            description, 
            latitude, 
            longitude, 
            contact_number = null, // Default to null
            email = null          // Default to null
        } = req.body;
        
        const owner_id = req.user.id;

        // Check for required fields
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
        const { name, description, price, shop_id, rating = 3.0 } = req.body; // Default rating
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

// --- (NEW: AI Feature Endpoints) ---

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

        // 3. Call Gemini to identify the food
        console.log("AI Image Search: Identifying image...");
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const foodName = response.text().trim();
        console.log(`AI Image Search: Identified food as: ${foodName}`);

        // 4. Call the reusable findProducts function
        const searchResults = await findProducts(foodName, latitude, longitude);

        // 5. Return the results
        res.json(searchResults);

    } catch (error) {
        console.error("\n--- !!! FULL AI IMAGE SEARCH ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred during image search.' });
    }
});

// --- *** NEW: MARKET TREND ENDPOINTS *** ---

/**
 * FEATURE 3: Add Market Price Data
 * This endpoint lets you add price data to your 'market_price' table.
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
 * This endpoint analyzes internal and external data to predict a trend.
 */
app.get('/ai/market-trend/:productName', async (req, res) => {
    try {
        const { productName } = req.params;
        console.log(`\n--- AI Market Trend: Received Request for ${productName} ---`);

        // 1. Get internal data from your 'market_price' table
        const { data: prices, error: dbError } = await supabase
            .from('market_price')
            .select('price, created_at')
            .ilike('product_name', productName) // Use ilike for case-insensitive
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
        console.error("\n--- !!! FULL AI MARKET TREND ERROR !!! ---");
        console.error(error);
         if (error instanceof SyntaxError && error.message.includes('JSON')) {
             return res.status(500).json({ error: 'The AI returned a response that was not valid JSON.' });
        }
        res.status(500).json({ error: 'An internal error occurred during trend analysis.' });
    }
});


// --- 5. Start the server ---
app.listen(PORT, () => {
    console.log(`Server is successfully running on http://localhost:${PORT}`);
});