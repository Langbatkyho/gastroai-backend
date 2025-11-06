// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 5001;
const DB_PATH = './db.json';

// --- Middleware ---
app.use(cors());
// Tăng giới hạn payload để nhận được ảnh base64
app.use(express.json({ limit: '10mb' })); 

// --- Database Helper Functions ---
// Hàm đọc dữ liệu từ db.json
const readDb = async () => {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // Nếu file không tồn tại, tạo file mới với object rỗng
        if (error.code === 'ENOENT') {
            await writeDb({});
            return {};
        }
        throw error;
    }
};

// Hàm ghi dữ liệu vào db.json
const writeDb = async (data) => {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
};

// --- API Endpoints for Data Management ---

// 1. Endpoint để đăng nhập/đăng ký
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }
    
    try {
        const db = await readDb();
        if (!db[email]) {
            // Nếu người dùng chưa tồn tại, tạo mới
            db[email] = {
                userProfile: null,
                symptoms: [],
            };
            await writeDb(db);
        }
        res.status(200).json({
            email,
            userProfile: db[email].userProfile,
            symptoms: db[email].symptoms
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
        const db = await readDb();
        if (!db[email]) {
            return res.status(404).json({ error: 'User not found' });
        }
        db[email].userProfile = profile;
        await writeDb(db);
        res.status(200).json(db[email].userProfile);
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
        const db = await readDb();
        if (!db[email]) {
            return res.status(404).json({ error: 'User not found' });
        }
        db[email].symptoms.push(symptom);
        await writeDb(db);
        res.status(201).json(db[email].symptoms);
    } catch (error) {
        console.error('Add symptom error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// --- Gemini API Proxy Endpoints ---

const getAi = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Endpoint để tạo thực đơn
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
      - Với mỗi món ăn, thêm một "ghi chú" ngắn gọn giải thích tại sao nó tốt cho tình trạng của người dùng (ví dụ: "Giàu chất xơ hòa tan, giúp làm dịu ni mạc dạ dày").
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
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const resultText = response.text.trim();
        res.json(JSON.parse(resultText));
    } catch (error) {
        console.error('Gemini meal plan error:', error);
        res.status(500).json({ error: 'Failed to generate meal plan' });
    }
});

// 2. Endpoint để kiểm tra thực phẩm
app.post('/api/gemini/check-food', async (req, res) => {
    const { profile, foodName, foodImage } = req.body;
    if (!profile || (!foodName && !foodImage)) {
        return res.status(400).json({ error: 'Profile and either food name or image are required' });
    }
    
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
    
    const schema = {
        type: Type.OBJECT,
        properties: {
            safetyLevel: { type: Type.STRING, enum: ["An toàn", "Hạn chế", "Tránh"] },
            reason: { type: Type.STRING, description: 'Lý do giải thích cho đánh giá' },
            scientificEvidence: { type: Type.STRING, description: 'Dẫn chứng khoa học và nguồn trích dẫn nếu có' }
        },
        required: ['safetyLevel', 'reason']
    };

    const textPart = { text: prompt };
    const parts = foodImage ? [{ inlineData: foodImage }, textPart] : [textPart];

    try {
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts },
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const resultText = response.text.trim();
        res.json(JSON.parse(resultText));
    } catch (error) {
        console.error('Gemini check food error:', error);
        res.status(500).json({ error: 'Failed to check food safety' });
    }
});

// 3. Endpoint để phân tích tác nhân
app.post('/api/gemini/analyze-triggers', async (req, res) => {
    const { profile, symptoms } = req.body;
    if (!profile || !symptoms) {
        return res.status(400).json({ error: 'Profile and symptoms are required' });
    }
    
    if(symptoms.length < 3) {
        return res.json("Chưa đủ dữ liệu để phân tích. Hãy ghi lại thêm các triệu chứng của bạn, bao gồm cả những ngày bạn cảm thấy khỏe (mức đau = 0).");
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
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });
        res.json(response.text);
    } catch (error) {
        console.error("Gemini analyze triggers error:", error);
        res.status(500).json({ error: 'Failed to analyze triggers' });
    }
});

// 4. Endpoint để gợi ý công thức
app.post('/api/gemini/suggest-recipe', async (req, res) => {
    const { profile, request } = req.body;
    if (!profile || !request) {
        return res.status(400).json({ error: 'Profile and request are required' });
    }

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
        const ai = getAi();
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const resultText = response.text.trim();
        const parsedResult = JSON.parse(resultText);
        // Thêm category tùy chỉnh để khớp với logic của frontend
        const finalRecipe = { ...parsedResult, category: 'AI Tùy chỉnh' };
        res.json(finalRecipe);
    } catch (error) {
        console.error("Gemini suggest recipe error:", error);
        res.status(500).json({ error: 'Failed to suggest recipe' });
    }
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
