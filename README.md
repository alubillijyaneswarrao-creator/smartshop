Smart Shop Backend 🛒🤖
A robust backend server for the "Smart Shop" application, built with Node.js, Express, and Supabase. This project features a location-aware smart search engine powered by Google Gemini AI, allowing users to find the best products nearby with intelligent ranking and summaries.

🚀 Features

User Authentication: Secure signup and login flows using Supabase Auth.
Automatic Profile Management: SQL triggers automatically create user profiles upon registration.
Shop & Product Management: Protected endpoints for shop owners to create shops and manage inventory.
Geospatial Search: Utilizes PostGIS to calculate distances and find shops within a specific radius.
AI-Powered Recommendations: Integrates Google Gemini (1.5 Flash) to analyze local inventory and provide ranked recommendations based on price and quality.
Row Level Security (RLS): Ensures data privacy where shop owners can only modify their own data.
🛠️ Tech Stack
Runtime: Node.js & Express.
Database: Supabase (PostgreSQL) with PostGIS extension.
AI Model: Google Generative AI (Gemini 1.5 Flash).
Authentication: Supabase Auth (JWT).

📋 Prerequisites
Run the command "npm install" in the project directory to install the dependdencies beforing starting the project.
Before running the project, ensure you have the following:
Node.js installed on your machine.
A Supabase account.
A Google AI Studio account (for the Gemini API key).
Postman (optional, for testing APIs).
