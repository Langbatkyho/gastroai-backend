// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require('@google/genai');
const db = require('./db'); // Import module database mới

const app = express();
const PORT = process.env.PORT || 5001;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- API Endpoints for Data Management ---

// 1. Endpoint để đăng nhập/đăng ký
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }
    
    try {
        // Kiểm tra user có tồn tại không
        let userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);

        // Nếu không, tạo user mới
        if (userResult.rows.length === 0) {
            await db.query('INSERT INTO users (email, user_profile) VALUES ($1, NULL)', [email]);
            userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        }

        // Lấy danh sách triệu chứng của user
        const symptomsResult = await db.query('SELECT log_data FROM symptoms WHERE user_email = $1 ORDER BY created_at ASC', [email]);
        
        res.status(200).json({
            email: userResult.rows[0].email,
            userProfile: userResult.rows[0].user_profile,
            symptoms: symptomsResult.rows.map(row => row.log_data) // Chỉ lấy cột log_data
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 2. Endpoint để lưu thông tin khảo sát (user profile)
app.post('/api/profile', async (req, res) => {
    const { email, profile } = req.body;
    if (!email || !profile) {
        return res.status(400).json({ error: 'Email and profile are required' });
    }
    
    try {
        const result = await db.query(
            'UPDATE users SET user_profile = $1 WHERE email = $2 RETURNING user_profile',
            [profile, email]
        );
        if (result.rows.length === 0) {
             return res.status(404).json({ error: 'User not found' });
        }
        res.status(200).json(result.rows[0].user_profile);
    } catch (error) {
        console.error('Save profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 3. Endpoint để thêm một ghi nhận triệu chứng
app.post('/api/symptoms', async (req, res) => {
    const { email, symptom } = req.body;
    if (!email || !symptom) {
        return res.status(400).json({ error: 'Email and symptom are required' });
    }

    try {
        // Thêm symptom mới vào DB
        await db.query(
            'INSERT INTO symptoms (id, user_email, log_data) VALUES ($1, $2, $3)',
            [symptom.id, email, symptom]
        );

        // Lấy lại toàn bộ danh sách symptoms đã được sắp xếp
        const symptomsResult = await db.query(
            'SELECT log_data FROM symptoms WHERE user_email = $1 ORDER BY created_at ASC',
            [email]
        );
        
        res.status(201).json(symptomsResult.rows.map(row => row.log_data));
    } catch (error) {
        console.error('Add symptom error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// --- Gemini API Proxy Endpoints (Không thay đổi) ---

const getAi = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/gemini/meal-plan', async (req, res) => {
    const { profile, symptoms } = req.body;
    if (!profile) {
        return res.status(400).json({ error: 'User profile is required' });
    }
    const symptomHistory = (symptoms || []).map(s => `- Vào ${new Date(s.timestamp).toLocaleString()}, đã ăn '${s.eatenFoods}' và bị đau mức ${s.painLevel}/10 tại ${s.painLocation}.`).join('\n');
    const prompt = `Dựa vào thông tin sức khỏe của người dùng sau đây, hãy tạo một kế hoạch thực đơn chi tiết cho 7 ngày tới...`; // Prompt giữ nguyên
    const schema = { type: Type.ARRAY, items: { /* schema giữ nguyên */ } };
    try {
        const ai = getAi();
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: "application/json", responseSchema: schema } });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error('Gemini meal plan error:', error);
        res.status(500).json({ error: 'Failed to generate meal plan' });
    }
});

app.post('/api/gemini/check-food', async (req, res) => {
    const { profile, foodName, foodImage } = req.body;
    if (!profile || (!foodName && !foodImage)) { return res.status(400).json({ error: 'Profile and either food name or image are required' }); }
    const prompt = `Phân tích thực phẩm này cho người dùng...`; // Prompt giữ nguyên
    const schema = { type: Type.OBJECT, properties: { /* schema giữ nguyên */ } };
    const textPart = { text: prompt };
    const parts = foodImage ? [{ inlineData: foodImage }, textPart] : [textPart];
    try {
        const ai = getAi();
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: { parts }, config: { responseMimeType: "application/json", responseSchema: schema } });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error('Gemini check food error:', error);
        res.status(500).json({ error: 'Failed to check food safety' });
    }
});

app.post('/api/gemini/analyze-triggers', async (req, res) => {
    const { profile, symptoms } = req.body;
    if (!profile || !symptoms) { return res.status(400).json({ error: 'Profile and symptoms are required' }); }
    if (symptoms.length < 3) { return res.json("Chưa đủ dữ liệu để phân tích..."); }
    const logData = symptoms.map(s => `...`).join('\n'); // Logic giữ nguyên
    const prompt = `Dựa trên hồ sơ người dùng và nhật ký sức khỏe sau đây...`; // Prompt giữ nguyên
    try {
        const ai = getAi();
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
        res.json(response.text);
    } catch (error) {
        console.error("Gemini analyze triggers error:", error);
        res.status(500).json({ error: 'Failed to analyze triggers' });
    }
});

app.post('/api/gemini/suggest-recipe', async (req, res) => {
    const { profile, request } = req.body;
    if (!profile || !request) { return res.status(400).json({ error: 'Profile and request are required' }); }
    const prompt = `Với vai trò là một chuyên gia dinh dưỡng...`; // Prompt giữ nguyên
    const schema = { type: Type.OBJECT, properties: { /* schema giữ nguyên */ } };
    try {
        const ai = getAi();
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: "application/json", responseSchema: schema } });
        const finalRecipe = { ...JSON.parse(response.text.trim()), category: 'AI Tùy chỉnh' };
        res.json(finalRecipe);
    } catch (error) {
        console.error("Gemini suggest recipe error:", error);
        res.status(500).json({ error: 'Failed to suggest recipe' });
    }
});

// --- Server Start ---
const startServer = async () => {
    await db.initializeDb(); // Chạy hàm khởi tạo DB trước khi server lắng nghe
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
};

startServer();
