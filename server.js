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
app.use(express.json({ limit: '10mb' })); // Tăng giới hạn để xử lý ảnh

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


// --- Gemini API Proxy Endpoints ---

const getAi = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Endpoint để tạo thực đơn
app.post('/api/gemini/meal-plan', async (req, res) => {
    const { profile, symptoms } = req.body;
    if (!profile) {
        return res.status(400).json({ error: 'User profile is required' });
    }
    const symptomHistory = (symptoms || []).map(s => `- Vào ${new Date(s.timestamp).toLocaleString()}, đã ăn '${s.eatenFoods}' và bị đau mức ${s.painLevel}/10 tại ${s.painLocation}.`).join('\n');

    const prompt = `
      Dựa vào thông tin sức khỏe của người dùng sau đây, hãy tạo một kế hoạch thực đơn chi tiết cho 7 ngày tới.
      HỒ SƠ NGƯỜI DÙNG:
      - Tình trạng bệnh lý: ${profile.condition}
      - Mức độ đau hiện tại: ${profile.painLevel}/10
      - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
      - Mục tiêu ăn kiêng: ${profile.dietaryGoal}
      LỊCH SỬ TRIỆU CHỨNG GẦN ĐÂY:
      ${symptomHistory || "Chưa có lịch sử triệu chứng."}
      YÊU CẦU:
      - Tạo thực đơn cho 7 ngày, mỗi ngày 3 bữa chính (sáng, trưa, tối) và 2 bữa phụ.
      - Các món ăn phải dễ tiêu hóa, phù hợp với tình trạng bệnh lý và mục tiêu của người dùng.
      - Tránh hoàn toàn các thực phẩm đã biết gây kích ứng.
      - Ghi rõ tên món ăn, thời gian ăn gợi ý, và khẩu phần ăn hợp lý.
      - Với mỗi món ăn, thêm một "ghi chú" ngắn gọn giải thích tại sao nó tốt cho tình trạng của người dùng (ví dụ: "Giàu chất xơ hòa tan, giúp làm dịu niêm mạc dạ dày").
      - Đảm bảo thực đơn đa dạng và đủ dinh dưỡng.
    `;
    
    const schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: {
                day: { type: Type.STRING },
                meals: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            time: { type: Type.STRING },
                            portion: { type: Type.STRING },
                            note: { type: Type.STRING }
                        },
                        required: ['name', 'time', 'portion', 'note']
                    }
                }
            },
            required: ['day', 'meals']
        }
    };

    try {
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error('Gemini meal plan error:', error);
        res.status(500).json({ error: 'Failed to generate meal plan' });
    }
});

// Endpoint để kiểm tra thực phẩm
app.post('/api/gemini/check-food', async (req, res) => {
    const { profile, foodName, foodImage } = req.body;
    if (!profile || (!foodName && !foodImage)) {
        return res.status(400).json({ error: 'Profile and food name or image are required' });
    }

    const prompt = `
      Phân tích thực phẩm này cho người dùng có thông tin sức khỏe sau:
      - Tình trạng bệnh lý: ${profile.condition}
      - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
      Thực phẩm cần kiểm tra: "${foodName || 'ảnh được cung cấp'}"
      YÊU CẦU:
      1. Đánh giá mức độ an toàn của thực phẩm này theo 3 cấp độ: "An toàn", "Hạn chế", "Tránh".
      2. Giải thích ngắn gọn lý do cho đánh giá của bạn.
      3. Cung cấp một "Dẫn chứng khoa học" ngắn gọn cho nhận định trên, nếu có thể.
    `;
    
    const textPart = { text: prompt };
    const parts = foodImage ? [{ inlineData: foodImage }, textPart] : [textPart];
    
    const schema = {
        type: Type.OBJECT,
        properties: {
            safetyLevel: { type: Type.STRING, enum: ["An toàn", "Hạn chế", "Tránh"] },
            reason: { type: Type.STRING },
            scientificEvidence: { type: Type.STRING }
        },
        required: ['safetyLevel', 'reason']
    };

    try {
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts },
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error('Gemini check food error:', error);
        res.status(500).json({ error: 'Failed to check food safety' });
    }
});

// Endpoint để phân tích nguyên nhân
app.post('/api/gemini/analyze-triggers', async (req, res) => {
    const { profile, symptoms } = req.body;
    if (!profile) {
        return res.status(400).json({ error: 'User profile is required' });
    }

    if(!symptoms || symptoms.length < 3) {
      const analysis = "Chưa đủ dữ liệu để phân tích. Hãy ghi lại thêm các triệu chứng của bạn, bao gồm cả những ngày bạn cảm thấy khỏe (mức đau = 0).";
      return res.json({ analysis });
    }

    const logData = symptoms.map(s => {
        const activity = s.physicalActivity ? `Vận động: "${s.physicalActivity}"` : 'Không vận động';
        const painDescription = s.painLevel > 0 ? `Đau mức ${s.painLevel}/10 tại ${s.painLocation}` : 'Không đau';
        return `- Ngày ${new Date(s.timestamp).toLocaleDateString()}: Ăn "${s.eatenFoods}". ${activity}. Kết quả: ${painDescription}.`;
    }).join('\n');

    const prompt = `
        Dựa trên hồ sơ người dùng và nhật ký sức khỏe sau đây, hãy thực hiện một phân tích so sánh chi tiết để xác định các yếu tố ảnh hưởng đến tình trạng của họ.
        HỒ SƠ NGƯỜI DÙNG:
        - Tình trạng bệnh lý: ${profile.condition}
        - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
        NHẬT KÝ SỨC KHỎE:
        ${logData}
        YÊU CẦU PHÂN TÍCH:
        1. Phân tích Tác nhân Gây đau (Thủ phạm): Xác định các loại thực phẩm, đồ uống, hoặc hoạt động thể chất thường xuất hiện TRƯỚC khi người dùng ghi nhận có cơn đau.
        2. Phân tích Yếu tố Tích cực (Những gì hiệu quả): Xác định các loại thực phẩm, đồ uống, hoặc hoạt động thể chất thường xuất hiện khi người dùng ghi nhận KHÔNG đau.
        3. So sánh và Đề xuất: Rút ra kết luận và đưa ra các đề xuất cụ thể, có tính hành động, phân thành 3 mục: NÊN TRÁNH, NÊN DUY TRÌ, và NÊN THỬ BỔ SUNG.
        Trình bày kết quả dưới dạng một báo cáo rõ ràng, dễ hiểu, sử dụng markdown với các tiêu đề in đậm.
    `;

    try {
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });
        res.json({ analysis: response.text });
    } catch (error) {
        console.error('Gemini analyze triggers error:', error);
        res.status(500).json({ error: 'Failed to analyze triggers' });
    }
});

// Endpoint để gợi ý công thức
app.post('/api/gemini/suggest-recipe', async (req, res) => {
    const { profile, request } = req.body;
    if (!profile || !request) {
        return res.status(400).json({ error: 'Profile and request are required' });
    }
    
    const prompt = `
      Với vai trò là một chuyên gia dinh dưỡng, hãy tạo một công thức nấu ăn mới dựa trên yêu cầu của người dùng và hồ sơ sức khỏe của họ.
      HỒ SƠ NGƯỜI DÙNG:
      - Tình trạng bệnh lý: ${profile.condition}
      - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
      - Mục tiêu ăn kiêng: ${profile.dietaryGoal}
      YÊU CẦU CỦA NGƯỜI DÙNG:
      "${request}"
      YÊU CẦU VỀ CÔNG THỨC:
      - Công thức phải tuyệt đối an toàn, dễ tiêu hóa, phù hợp với hồ sơ người dùng.
      - Cung cấp tên món ăn (title), mô tả ngắn (description), thời gian nấu (cookTime), danh sách nguyên liệu (ingredients) và hướng dẫn chi tiết (instructions).
    `;
    
    const schema = {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            cookTime: { type: Type.STRING },
            ingredients: { type: Type.ARRAY, items: { type: Type.STRING } },
            instructions: { type: Type.STRING }
        },
        required: ['title', 'description', 'cookTime', 'ingredients', 'instructions']
    };

    try {
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const parsedResult = JSON.parse(response.text.trim());
        const finalRecipe = { ...parsedResult, category: 'AI Tùy chỉnh' };
        res.json(finalRecipe);
    } catch (error) {
        console.error('Gemini suggest recipe error:', error);
        res.status(500).json({ error: 'Failed to suggest recipe' });
    }
});


// --- Server Start ---
const startServer = async () => {
  await db.initializeDb(); // Khởi tạo DB trước khi server chạy
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
};

startServer();
