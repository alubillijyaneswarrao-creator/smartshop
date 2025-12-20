const express = require('express');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer'); 
const fetch = require('node-fetch'); 
const app = express();
const PORT = 3000;
console.log("Starting server setup...");
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("FATAL ERROR: Supabase URL or Key is missing.");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized.");
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.warn("WARNING: Gemini API Key is missing. AI features will not work.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
console.log("Google AI client initialized.");
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
async function getOrSimulateExternalPrice(productName) {
    console.log(`Getting external price for: ${productName}`);
    const basePrices = {
        'burger': 150,
        'pizza': 300,
        'samosa': 20,
    };
    const basePrice = basePrices[productName.toLowerCase()] || 100; 
    const simulatedPrice = (basePrice + (Math.random() - 0.5) * 20).toFixed(2); 
    return Promise.resolve({ 
        price: parseFloat(simulatedPrice), 
        source: 'Simulated External Market' 
    });
}
async function findProducts(query, latitude, longitude) {
    console.log(`findProducts: Searching for "${query}" near ${latitude}, ${longitude}`);
    const { data: shops, error: shopsError } = await supabase.rpc('nearby_shops', {
        lat: latitude,
        long: longitude
    });
    if (shopsError) throw shopsError;

    if (!shops || shops.length === 0) {
        return { summary: "No shops found near your location.", recommendations: [] };
    }
    console.log(`findProducts: Found ${shops.length} shops.`);
    const shopIds = shops.map(shop => shop.id);
    const { data: products, error: productsError } = await supabase
        .from('products')
        .select('*, shops (name, contact_number, email)') 
        .in('shop_id', shopIds)
        .ilike('name', `%${query}%`); 
    if (productsError) throw productsError;
    if (!products || products.length === 0) {
        return { summary: `No products matching "${query}" found in nearby shops.`, recommendations: [] };
    }
    console.log(`findProducts: Found ${products.length} products matching query.`);
    const contextForAI = products.map(p => ({
        product_name: p.name,
        price: p.price,
        rating: p.rating,
        shop_name: p.shops ? p.shops.name : 'Unknown Shop',
        contact_number: p.shops ? p.shops.contact_number : null,
        email: p.shops ? p.shops.email : null,
        shop_id: p.shop_id
    }));
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
              "stock_quantity":"90"
              "reason": "Brief reason for recommendation."
            }
          ]
        }
    `;
    console.log("findProducts: Calling Gemini API...");
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanedText);
}
app.get('/', (req, res) => {
    res.json({ message: "Success! Your Smart Shop backend is running." });
});
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
        const { name, description, price, shop_id, rating = 3.0, stock_quantity=10 } = req.body; 
        const { data, error } = await supabase
            .from('products')
            .insert({ name, description, price, shop_id, rating,stock_quantity })
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
        let query = supabase.from('products').select('*, shops (name, contact_number, email,stock_quantity)');
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
        const imagePart = {
            inlineData: {
                data: imageFile.buffer.toString("base64"),
                mimeType: imageFile.mimetype
            }
        };
        const prompt = "Identify the food in this image. Respond with ONLY the name of the food (e.g., 'Burger', 'Pizza', 'Samosa'). Do not add any other text.";
        console.log("AI Image Search: Identifying image...");
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const foodName = response.text().trim();
        console.log(`AI Image Search: Identified food as: ${foodName}`);
        const searchResults = await findProducts(foodName, latitude, longitude);
        res.json(searchResults);
    } catch (error) {
        console.error("\n--- !!! FULL AI IMAGE SEARCH ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred during image search.' });
    }
});
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


app.get('/ai/market-trend/:productName', async (req, res) => {
    try {
        const { productName } = req.params;
        console.log(`\n--- AI Market Trend: Received Request for ${productName} ---`);

        const { data: prices, error: dbError } = await supabase
            .from('market_price')
            .select('price, created_at')
            .ilike('product_name', productName)
            .order('created_at', { ascending: false })
            .limit(30);

        if (dbError) throw dbError;

        let internalTrend = "Insufficient Data";
        let internalPrice = null;
        if (prices && prices.length > 0) {
            internalPrice = prices[0].price; 
            if (prices.length > 1) {
                const latestPrice = prices[0].price;
                const olderPrices = prices.slice(1);
                const avgOldPrice = olderPrices.reduce((acc, p) => acc + p.price, 0) / olderPrices.length;
                
                if (latestPrice > avgOldPrice * 1.05) {
                    internalTrend = "Rising";
                } else if (latestPrice < avgOldPrice * 0.95) { 
                    internalTrend = "Falling";
                } else {
                    internalTrend = "Stable";
                }
            }
        }
        console.log(`AI Market Trend: Internal trend is ${internalTrend}`);

        const externalData = await getOrSimulateExternalPrice(productName);
        console.log(`AI Market Trend: External data is ${externalData.price} from ${externalData.source}`);

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
app.post('/sales', protectRoute, async (req, res) => {
    try {
        const { shop_id, items } = req.body; 
        
        if (!shop_id || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'shop_id and an array of items are required.' });
        }

        
        for (const item of items) {
            const { error } = await supabase.rpc('record_sale', {
                sale_shop_id: shop_id,
                sale_product_id: item.product_id,
                quantity: item.quantity
            });
            if (error) throw error;
        }
        res.status(201).json({ message: 'Sales recorded and inventory updated successfully.' });

    } catch (error) {
        console.error("\n--- !!! RECORD SALE ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred while recording the sale.' });
    }
});

app.get('/ai/inventory-prediction/:shop_id', protectRoute, async (req, res) => {
    try {
        const { shop_id } = req.params;
        console.log(`\n--- AI Inventory Prediction: Request for shop ${shop_id} ---`);

        const { data: products, error: productError } = await supabase
            .from('products')
            .select(`
                name,
                stock_quantity,
                sales ( created_at, quantity_sold )
            `)
            .eq('shop_id', shop_id);
        
        if (productError) throw productError;
        if (!products || products.length === 0) {
            return res.json({ prediction: "No products found for this shop." });
        }

        const contextForAI = products.map(product => {
            const salesLast30Days = product.sales.filter(sale => {
                const saleDate = new Date(sale.created_at);
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                return saleDate > thirtyDaysAgo;
            });

            const totalSold = salesLast30Days.reduce((acc, curr) => acc + curr.quantity_sold, 0);
            const avgDailySales = (totalSold / 30).toFixed(2);
            
            return {
                product_name: product.name,
                current_stock: product.stock_quantity,
                avg_daily_sales_30d: parseFloat(avgDailySales)
            };
        });

        const prompt = `
            You are an expert inventory management assistant for a small retail shop.
            Analyze the following product data, which includes current stock and average daily sales over the last 30 days.
            A product needs reordering if its current stock will last for less than 7 days (stock / avg_daily_sales < 7).

            Product Data:
            ${JSON.stringify(contextForAI)}

            Your tasks:
            1. Create a brief, one-sentence summary of the overall inventory health.
            2. Create a list called "reorder_list" containing ONLY the products that need to be reordered.
            3. For each product in the reorder list, provide a 'priority' ('High' if less than 3 days of stock left, 'Medium' otherwise) and a 'suggested_reorder_quantity' (enough for 14 days, which is avg_daily_sales * 14, rounded up to the nearest whole number).

            Respond ONLY with a valid JSON object in the following format.
            {
              "summary": "Your one-sentence summary here.",
              "reorder_list": [
                {
                  "product_name": "Product Name",
                  "current_stock": 10,
                  "days_of_stock_left": 2.5,
                  "priority": "High",
                  "suggested_reorder_quantity": 56
                }
              ]
            }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        
        res.json(JSON.parse(text));

    } catch (error) {
        console.error("\n--- !!! AI INVENTORY ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred during inventory analysis.' });
    }
});


app.get('/ai/seasonal-recommendations', protectRoute, async (req, res) => {
    try {
        console.log(`\n--- AI Seasonal Recommendations Request ---`);

        const sixtyDaysFromNow = new Date();
        sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
        
        const { data: events, error: eventError } = await supabase
            .from('events')
            .select('name, start_date')
            .lte('start_date', sixtyDaysFromNow.toISOString().split('T')[0]) 
            .gte('end_date', new Date().toISOString().split('T')[0]); 

        if (eventError) throw eventError;

       
        const prompt = `
            You are an expert retail consultant for shops in India.
            The current date is ${new Date().toDateString()}.
            The following festivals and seasons are upcoming:
            ${JSON.stringify(events)}

            Based on these events, suggest a list of 5 general product categories that a local shop should consider stocking up on. For each category, provide a brief, one-sentence reason linking it to the upcoming events.

            Respond ONLY with a valid JSON object in the following format.
            {
              "recommendations": [
                {
                  "category": "Suggested Category (e.g., 'Sweets and Mithai')",
                  "reason": "Your one-sentence reason here."
                }
              ]
            }
        `;
        
      
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        
        res.json(JSON.parse(text));

    } catch (error) {
        console.error("\n--- !!! AI SEASONAL ERROR !!! ---");
        console.error(error);
        res.status(500).json({ error: 'An internal error occurred during seasonal analysis.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is successfully running on http://localhost:${PORT}`);
});