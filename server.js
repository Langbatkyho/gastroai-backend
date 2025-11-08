// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { GoogleGenAI, Type } = require('@google/genai');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 characters

if (!JWT_SECRET || !ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    throw new Error("JWT_SECRET and a 32-character ENCRYPTION_KEY must be set in .env file");
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Crypto Helpers ---
const IV_LENGTH = 16;
const encrypt = (text) => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
};

// --- Auth Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- Auth Endpoints ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hashedPassword]);
        res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
        console.error('Registration error:', error);
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = userResult.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const symptomsResult = await db.query('SELECT log_data FROM symptoms WHERE user_email = $1 ORDER BY created_at ASC', [email]);
        
        const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            user: {
                email: user.email,
                profile: user.user_profile,
                hasApiKey: !!user.encrypted_gemini_key,
            },
            symptoms: symptomsResult.rows.map(row => row.log_data)
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- User Data Endpoints (Protected) ---
app.post('/api/api-key', authenticateToken, async (req, res) => {
    const { apiKey } = req.body;
    const email = req.user.email;
    if (!apiKey) {
        return res.status(400).json({ error: 'API key is required' });
    }
    try {
        const encryptedKey = encrypt(apiKey);
        await db.query('UPDATE users SET encrypted_gemini_key = $1 WHERE email = $2', [encryptedKey, email]);
        res.status(200).json({ message: 'API key saved successfully' });
    } catch (error) {
        console.error('API key save error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/profile', authenticateToken, async (req, res) => {
    const { profile } = req.body;
    const email = req.user.email;
    if (!profile) return res.status(400).json({ error: 'Profile data is required' });
    
    try {
        const result = await db.query('UPDATE users SET user_profile = $1 WHERE email = $2 RETURNING user_profile', [profile, email]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.status(200).json(result.rows[0].user_profile);
    } catch (error) {
        console.error('Save profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/symptoms', authenticateToken, async (req, res) => {
    const { symptom } = req.body;
    const email = req.user.email;
    if (!symptom) return res.status(400).json({ error: 'Symptom data is required' });

    try {
        await db.query('INSERT INTO symptoms (id, user_email, log_data) VALUES ($1, $2, $3)', [symptom.id, email, symptom]);
        const symptomsResult = await db.query('SELECT log_data FROM symptoms WHERE user_email = $1 ORDER BY created_at ASC', [email]);
        res.status(201).json(symptomsResult.rows.map(row => row.log_data));
    } catch (error) {
        console.error('Add symptom error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Gemini API Proxy (Protected) ---
const getAiForUser = async (email) => {
    const result = await db.query('SELECT encrypted_gemini_key FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0 || !result.rows[0].encrypted_gemini_key) {
        throw new Error('User does not have an API key set.');
    }
    const decryptedKey = decrypt(result.rows[0].encrypted_gemini_key);
    return new GoogleGenAI({ apiKey: decryptedKey });
};

app.post('/api/gemini/meal-plan', authenticateToken, async (req, res) => {
    const { profile, symptoms } = req.body;
    const email = req.user.email;
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
                day: { type: Type.STRING, description: 'Ngày trong tuần (ví dụ: Ngày 1, Thứ Hai)' },
                meals: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING, description: 'Tên món ăn' },
                            time: { type: Type.STRING, description: 'Thời gian ăn gợi ý (ví dụ: 7:00 AM)' },
                            portion: { type: Type.STRING, description: 'Khẩu phần gợi ý (ví dụ: 1 bát nhỏ)' },
                            note: { type: Type.STRING, description: 'Ghi chú ngắn gọn về lợi ích của món ăn' }
                        },
                        required: ['name', 'time', 'portion', 'note']
                    }
                }
            },
            required: ['day', 'meals']
        }
    };

    try {
        const ai = await getAiForUser(email);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error('Gemini meal plan error:', error);
        res.status(500).json({ error: 'Failed to generate meal plan. Check your API key.' });
    }
});

app.post('/api/gemini/check-food', authenticateToken, async (req, res) => {
    const { profile, foodName, foodImage } = req.body;
    const email = req.user.email;
    const prompt = `
      Phân tích thực phẩm này cho người dùng có thông tin sức khỏe sau:
      - Tình trạng bệnh lý: ${profile.condition}
      - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
      Thực phẩm cần kiểm tra: "${foodName}"
      YÊU CẦU:
      1. Đánh giá mức độ an toàn của thực phẩm này theo 3 cấp độ: "An toàn", "Hạn chế", "Tránh".
      2. Giải thích ngắn gọn lý do cho đánh giá của bạn.
      3. Cung cấp một "Dẫn chứng khoa học" ngắn gọn cho nhận định trên, nếu có thể, hãy trích dẫn nguồn (ví dụ: tên nghiên cứu, bài báo y khoa). Nếu không có dẫn chứng cụ thể, hãy giải thích dựa trên nguyên tắc dinh dưỡng chung.
    `;
    const textPart = { text: prompt };
    const parts = foodImage ? [{ inlineData: foodImage }, textPart] : [textPart];
    const schema = {
        type: Type.OBJECT,
        properties: {
            safetyLevel: { type: Type.STRING, enum: ["An toàn", "Hạn chế", "Tránh"] },
            reason: { type: Type.STRING, description: 'Lý do giải thích cho đánh giá' },
            scientificEvidence: { type: Type.STRING, description: 'Dẫn chứng khoa học và nguồn trích dẫn nếu có' }
        },
        required: ['safetyLevel', 'reason']
    };
    try {
        const ai = await getAiForUser(email);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts },
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        res.json(JSON.parse(response.text.trim()));
    } catch (error) {
        console.error("Error checking food safety:", error);
        res.status(500).json({ error: 'Failed to check food. Check your API key.' });
    }
});

app.post('/api/gemini/analyze-triggers', authenticateToken, async (req, res) => {
    const { profile, symptoms } = req.body;
    const email = req.user.email;
    if(!symptoms || symptoms.length < 3) {
      return res.json({ analysis: "Chưa đủ dữ liệu để phân tích. Hãy ghi lại thêm các triệu chứng của bạn, bao gồm cả những ngày bạn cảm thấy khỏe (mức đau = 0)."});
    }

    const logData = symptoms.map(s => {
        const activity = s.physicalActivity ? `Vận động: "${s.physicalActivity}"` : 'Không vận động';
        const painDescription = s.painLevel > 0 ? `Đau mức ${s.painLevel}/10 tại ${s.painLocation}` : 'Không đau';
        const symptomDate = new Date(s.timestamp);
        return `- Ngày ${symptomDate.toLocaleDateString()}: Ăn "${s.eatenFoods}". ${activity}. Kết quả: ${painDescription}.`;
    }).join('\n');

    const prompt = `
        Dựa trên hồ sơ người dùng và nhật ký sức khỏe sau đây, hãy thực hiện một phân tích so sánh chi tiết để xác định các yếu tố ảnh hưởng đến tình trạng của họ.
        HỒ SƠ NGƯỜI DÙNG:
        - Tình trạng bệnh lý: ${profile.condition}
        - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
        NHẬT KÝ SỨC KHỎE:
        ${logData}
        YÊU CẦU PHÂN TÍCH:
        1.  **Phân tích Tác nhân Gây đau (Thủ phạm):**
            *   Xác định các loại thực phẩm, đồ uống, hoặc hoạt động thể chất thường xuất hiện TRƯỚC khi người dùng ghi nhận có cơn đau (mức đau > 0).
            *   Đưa ra giả thuyết về các "thủ phạm" tiềm tàng. Ví dụ: "Ăn đồ cay và không vận động sau đó có vẻ liên quan đến các cơn đau ở vùng thượng vị."
        2.  **Phân tích Yếu tố Tích cực (Những gì hiệu quả):**
            *   Xác định các loại thực phẩm, đồ uống, hoặc hoạt động thể chất thường xuất hiện khi người dùng ghi nhận KHÔNG đau (mức đau = 0).
            *   Tìm ra các "yếu tố bảo vệ" hoặc thói quen tốt. Ví dụ: "Những ngày bạn ăn cháo yến mạch cho bữa sáng và đi bộ nhẹ nhàng, bạn thường không bị đau."
        3.  **So sánh và Đề xuất:**
            *   So sánh hai nhóm phân tích trên để rút ra kết luận.
            *   Đưa ra các đề xuất cụ thể, có tính hành động. Phân thành 3 mục:
                *   **NÊN TRÁNH:** Liệt kê những thứ cần hạn chế hoặc tránh.
                *   **NÊN DUY TRÌ:** Liệt kê những thói quen tốt cần tiếp tục.
                *   **NÊN THỬ BỔ SUNG:** Gợi ý những thay đổi hoặc bổ sung mới dựa trên phân tích. Ví dụ: "Hãy thử thay thế cà phê buổi sáng bằng trà gừng, và thêm 15 phút đi bộ sau bữa trưa."
        Trình bày kết quả dưới dạng một báo cáo rõ ràng, dễ hiểu, sử dụng markdown với các tiêu đề in đậm.
    `;

    try {
        const ai = await getAiForUser(email);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });
        res.json({ analysis: response.text });
    } catch (error) {
        console.error("Error analyzing triggers:", error);
        res.status(500).json({ error: 'Failed to analyze. Check your API key.' });
    }
});

app.post('/api/gemini/suggest-recipe', authenticateToken, async (req, res) => {
    const { profile, request } = req.body;
    const email = req.user.email;
    const prompt = `
      Với vai trò là một chuyên gia dinh dưỡng cho người bị bệnh về dạ dày, hãy tạo một công thức nấu ăn mới dựa trên yêu cầu của người dùng và hồ sơ sức khỏe của họ.
      HỒ SƠ NGƯỜI DÙNG:
      - Tình trạng bệnh lý: ${profile.condition}
      - Các thực phẩm đã biết gây kích ứng: ${profile.triggerFoods}
      - Mục tiêu ăn kiêng: ${profile.dietaryGoal}
      YÊU CẦU CỦA NGƯỜI DÙNG:
      "${request}"
      YÊU CẦU VỀ CÔNG THỨC:
      - Công thức phải tuyệt đối an toàn, dễ tiêu hóa, phù hợp với hồ sơ người dùng.
      - Tránh tất cả các thực phẩm gây kích ứng đã biết.
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
        const ai = await getAiForUser(email);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const result = JSON.parse(response.text.trim());
        res.json({ ...result, category: 'AI Tùy chỉnh' });
    } catch (error) {
        console.error("Error suggesting recipe:", error);
        res.status(500).json({ error: 'Failed to suggest recipe. Check your API key.' });
    }
});


// --- Server Start ---
const startServer = async () => {
  await db.initializeDb();
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
};

startServer();
