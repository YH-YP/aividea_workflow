// deepseek.js - 渐进式视频分镜生成逻辑

// API 配置
const API_CONFIG = {
    official: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        name: '官方API'
    },
    thirdParty: {
        baseUrl: 'https://llmapi.paratera.com',
        model: 'DeepSeek-V3.2', 
        name: '第三方API',
        models: [
            { id: 'DeepSeek-V3.2', name: 'DeepSeek-V3.2 (默认)' },
            { id: 'DeepSeek-V3.2-Exp', name: 'DeepSeek-V3.2-Exp (实验版)' },
            { id: 'DeepSeek-V3.1', name: 'DeepSeek-V3.1 (极速)' }
        ]
    }
};

const ZHIPU_BASE_URL = "https://zhipu-proxy.1963087187.workers.dev";

// 全局状态
let currentApiConfig = API_CONFIG.thirdParty;
let globalConcept = null;   // 存储策划大纲
let globalScenes = [];      // 存储分镜列表
let videoTasks = {};        // 视频任务状态

// 当前可中断的操作（策划/生成分镜/细化脚本/批量等）
let currentOpController = null;
let currentOpLabel = '';

document.addEventListener('DOMContentLoaded', () => {
    initUI();
});

function beginCancelableOp(label) {
    // 如果上一轮还在跑，先中断（避免多次点击造成并发和UI错乱）
    if (currentOpController) {
        try { currentOpController.abort(); } catch (_) {}
    }
    currentOpController = new AbortController();
    currentOpLabel = label || '';
    setCancelButtonVisible(true, currentOpLabel);
    return currentOpController.signal;
}

function endCancelableOp() {
    currentOpController = null;
    currentOpLabel = '';
    setCancelButtonVisible(false);
}

function cancelCurrentOp() {
    if (currentOpController) {
        currentOpController.abort();
    }
    // 立即给用户反馈，不等网络返回
    updateProgress(0, '已中断', 1);
    setCancelButtonVisible(false);
}

function setCancelButtonVisible(visible, label) {
    const btn = document.getElementById('cancelBtn');
    if (!btn) return;
    if (visible) {
        btn.classList.remove('d-none');
        btn.disabled = false;
        btn.title = label ? `中断：${label}` : '中断当前生成';
    } else {
        btn.classList.add('d-none');
        btn.disabled = false;
        btn.title = '';
    }
}

function resetSessionUIState() {
    // 重置 Step2/Step3 相关按钮与容器，保证“换主题重新生成”不会被上一轮状态锁死
    const nextBtn = document.getElementById('generateNextSceneBtn');
    if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.innerHTML = '<i class="bi bi-plus"></i> 生成下一个分镜';
    }

    const allVideosBtn = document.getElementById('generateAllVideosBtn');
    if (allVideosBtn) {
        allVideosBtn.style.display = 'none';
        allVideosBtn.disabled = false;
    }

    const batchScriptBtn = document.getElementById('batchDetailBtn');
    if (batchScriptBtn) batchScriptBtn.style.display = 'none';

    const container = document.getElementById('storyboardContainer');
    if (container) container.innerHTML = '';
}

function initUI() {
    // 1. API 切换
    const officialRadio = document.getElementById('officialApi');
    const thirdPartyRadio = document.getElementById('thirdPartyApi');
    const tpModelSelect = document.getElementById('thirdPartyModelSelect');
    const tpModelDropdown = document.getElementById('tpModel');
    const apiInfo = document.getElementById('apiInfo');

    const updateApiInfo = () => {
        if (officialRadio.checked) {
            currentApiConfig = API_CONFIG.official;
            tpModelSelect.classList.add('d-none');
        } else {
            // 第三方模式，使用下拉框选中的模型
            currentApiConfig = { 
                ...API_CONFIG.thirdParty, 
                model: tpModelDropdown.value 
            };
            tpModelSelect.classList.remove('d-none');
        }
        apiInfo.textContent = `当前: ${currentApiConfig.name} (${currentApiConfig.model})`;
    };

    officialRadio.addEventListener('change', updateApiInfo);
    thirdPartyRadio.addEventListener('change', updateApiInfo);
    tpModelDropdown.addEventListener('change', updateApiInfo); // 监听模型切换
    updateApiInfo();

    // 2. 按钮绑定
    document.getElementById('generateBtn').addEventListener('click', startStep1_Planning); // Step 1: 策划
    document.getElementById('exportBtn').addEventListener('click', exportResult);
    // Step 2: 生成下一个分镜（使用页面底部的固定按钮，避免重复id引发事件混乱）
    document.getElementById('generateNextSceneBtn').addEventListener('click', generateNextScene);
    // 中断按钮（可中断策划/生成分镜/细化脚本等）
    document.getElementById('cancelBtn')?.addEventListener('click', cancelCurrentOp);
    
    // 3. 一键生成所有视频按钮
    document.getElementById('generateAllVideosBtn').addEventListener('click', generateAllVideos);

    // 4. API 测试按钮
    document.getElementById('testApiBtn').addEventListener('click', async () => {
        const apiKey = document.getElementById('apiKey').value.trim();
        if (!apiKey) { alert('请先输入 API Key'); return; }
        
        try {
            await callDeepSeek(apiKey, "你是一个测试助手。", "请回复'OK'。", 50, 15000);
            // 成功的提示已在 callDeepSeek 内部处理 (变为绿色)
        } catch (e) {
            console.error(e);
            alert("API 测试失败: " + e.message);
        }
    });
}

// ==========================================
// Step 1: 创意策划与大纲 (Planning)
// ==========================================

async function startStep1_Planning() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const topic = document.getElementById('topic').value.trim();
    const sceneCount = parseInt(document.getElementById('sceneCount').value);
    const sceneDuration = parseInt(document.getElementById('sceneDuration').value);

    if (!apiKey) { showError('请输入 DeepSeek API Key'); return; }
    if (!topic) { showError('请输入视频主题'); return; }

    hideError();
    document.getElementById('resultSection').classList.add('d-none');
    document.getElementById('progressSection').classList.remove('d-none');
    document.getElementById('generateBtn').disabled = true;

    // UI：换主题重新开始时，必须清理上一轮的“完成态/禁用态”
    resetSessionUIState();

    resetSteps();
    updateProgress(10, 'DeepSeek 正在进行全局策划与分镜拆解...', 1);

    try {
        const abortSignal = beginCancelableOp('策划生成');
        // 初始化全局状态
        globalScenes = [];
        globalConcept = null;
        videoTasks = {};
        let currentSceneIndex = 0;
        
        // 生成第一个分镜
        await generateNextSceneData(apiKey, topic, sceneCount, sceneDuration, currentSceneIndex, abortSignal);
        
        // 渲染第一个分镜UI
        renderStep2_UI();
        
        // 激活 Step 2 状态
        document.getElementById('step2-num').classList.add('active');
        
        updateProgress(100, '策划完成，请进行分镜细化', 1, true);
        
    } catch (error) {
        console.error(error);
        if (String(error?.message || '').includes('已中断')) {
            updateProgress(0, '已中断', 1);
        } else {
            showError(error.message);
            updateProgress(0, '策划失败', 1);
        }
    } finally {
        endCancelableOp();
        document.getElementById('generateBtn').disabled = false;
        document.getElementById('progressSection').classList.add('d-none');
    }
}

// 生成下一个分镜（数据层函数：只负责向 globalScenes 追加一个新分镜，不做界面跳转/按钮状态修改）
async function generateNextSceneData(apiKey, topic, totalScenes, duration, index, abortSignal) {
    if (index >= totalScenes) return null;

    updateProgress(30 + (index * 70 / totalScenes), `正在生成第 ${index + 1} 个分镜...`, 1);

    // 参考已生成内容，保证风格一致与递进
    const existingScenes = globalScenes.slice(0, index);
    const existingSummaries = existingScenes.map(s => s.summary).filter(Boolean).join('\n- ');

    const systemPrompt = `你是一位精通AI视频生成的创意总监和分镜师，擅长从复杂主题中提炼核心创意。你的任务是根据主题构思具有高视觉冲击力和情感深度的视频大纲。

**关键注意：**

用户的输入 [主题] 可能是一份结构化的"策划方案"或"制作规范"。

**请将这些规范视为"核心参考指南"**，在保持原意图的基础上进行专业的视听化转译：

1. **风格对齐**：参考输入中定义的画风与光影质感，确保整体调性统一。
2. **运镜借鉴**：灵活运用输入中建议的运镜方式，根据具体画面张力进行优化。
3. **元素融合**：自然地将要求的关键细节融入场景，而非生硬堆砌。

**核心目标：**

将抽象的主题转化为具体的、具有情感共鸣的视觉画面，同时保持创意的深度和独特性。

**深度分析要求：**

1. **主题类型识别与分层分析：**
   - 识别主题的核心类型（叙事类/展示类/概念类/情感类）
   - 分析主题的表层含义和深层隐喻
   - 识别主题中的关键元素和情感基调

2. **附加内容整合：**
   - 识别主题中隐含的背景故事、文化符号或情感层次
   - 将附加内容转化为视觉元素，增强视频的深度
   - 确保每个镜头都能体现主题的多维度含义

3. **创意策略制定：**
   - 根据主题调性选择合适的视觉风格（如：写实主义、超现实主义、极简主义等）
   - 设计镜头间的逻辑递进或情感递进
   - 确保整体视觉语言的一致性和创新性

**输入信息：**

主题：${topic}
分镜数：${totalScenes}
单镜头时长：${duration}秒
当前生成序号：${index + 1}

**重要：多场景时间线切换要求**
当单个分镜涉及多个场景时，必须在summary中一开始就明确描述时间线和场景切换过程。不要只描述第一个场景，而是要从时间线开始就完整描述所有场景变化。
示例："0-2秒：室内书房，老人坐在桌前翻看旧照片；2-4秒：镜头推近照片，画面渐变为回忆中的年轻时代；4-7秒：回到现实，老人眼含泪光特写"

**已生成分镜参考：**

${existingSummaries ? `已生成的分镜内容：\n- ${existingSummaries}` : '尚未生成任何分镜'}

**执行要求：**

1.  **内容策略分析：**
    * 首先判断主题类型。如果是叙事类（如"爱情故事"），确保镜头间的逻辑连贯和情绪递进。
    * 如果是展示类/非连续类（如"${topic}"），请侧重于单镜头的视觉张力、构图美感及核心特征的精准表达，但需保持整体色调或氛围的统一性。
    * 如果是概念类/情感类，请注重象征性视觉元素的运用和情感氛围的营造。

2.  **画面简述标准（关键，必须严格遵守）：**
    * **多场景时间线描述（强制要求）**：当分镜涉及多个场景切换时，必须在summary中明确描述时间线和场景切换的过程。不要只描述第一个场景，而是要完整描述从开始到结束的所有场景变化，包括时间点和过渡方式。例如："0-2秒：室内书房，老人坐在桌前翻看旧照片；2-4秒：镜头推近照片，画面渐变为回忆中的年轻时代；4-7秒：回到现实，老人眼含泪光特写"。
    * **平衡抽象与具体**：在描述抽象概念时，必须同时提供具体的视觉细节作为支撑。例如：描述"孤独"时，要同时描述"空荡房间里的单人沙发、窗外的雨滴、墙上的旧照片"等具体元素。
    * **背景细节必须爆炸丰富（硬指标）**：在 [环境/背景细节] 中必须给出 **至少 10 个**具体可见元素（用"、"分隔），并且至少包含：
      - **前景元素 ≥ 4**（例如：水珠挂在金属边缘、漂浮的细尘、镜头边缘的枝叶剪影、花瓣、雨滴、反光表面、书籍封面、装饰品）
      - **中景元素 ≥ 4**（例如：建筑、人物/生物的局部、道具、符号、装饰画、植物、家具、灯光装置）
      - **远景元素 ≥ 2**（例如：天际线、山脉、巨构、极光、云层结构、城市天际线、天空变化）
    * **场景切换与过渡设计（强制要求）**：每个分镜必须明确标注其所属的场景类型和场景切换信息：
    - 场景类型：必须标注是"室内场景"、"室外场景"、"过渡场景"还是"概念场景"
    - 场景切换时间点：必须标注场景开始和结束的时间范围（如"0-3秒：室内场景"、"3-6秒：通过窗户看到室外变化"）
    - 场景过渡元素：必须描述用于暗示场景转换的视觉元素
    - 这些信息必须体现在JSON输出的相应字段中（scene_type, scene_transition, scene_timeline）
    * **主题锚点防跑题（硬指标）**：每个镜头必须显式包含 [主题锚点符号]，其中至少 2 个符号/意象必须与主题"${topic}"强相关（例如：概念具象化的符号、文化符号、关键道具、重复出现的图腾/标记）。
    * **一致性与递进（硬指标）**：
      - 如果已有分镜，则本镜头必须 **继承至少 1 个**已出现的视觉母题/背景元素（保持世界观连续），并在此基础上 **新增 1-2 个**更强烈的新视觉亮点（实现递进）。
      - 色调/镜头语言应与已生成分镜一致（例如：同一套冷暖对比、同一种慢推/环绕/微距逻辑）。
    * **动作与动态（硬指标）**：[关键动作/动态] 至少包含 **2 个**可视化动作或动态变化（如"雨滴滑落并折射霓虹""瞳孔收缩、鳞片微颤、蒸汽上升"）。
    * **镜头语言（硬指标）**：必须写明 [运镜/镜头语言]（如：慢推、摇镜、环绕、跟拍、俯冲、微距拉近）和 **景深/焦点变化**（如"浅景深锁定前景水珠，背景虚化"）。
    * **材质与光影（硬指标）**：[光影/材质] 至少包含 **5 个**材质/光影细节（如"湿润金属拉丝反光、体积雾、轮廓光、丁达尔光束、冷暖对比、玻璃折射、布料纹理、金属光泽"）。
    * **装饰与背景细节**：根据场景类型添加合适的装饰元素：
      - 室内场景：添加家具、装饰画、植物、灯光装置、书籍、个人物品等
      - 室外场景：添加天气效果、植被、建筑细节、天空元素、街道设施等
      - 概念场景：添加符号、隐喻元素、抽象装饰、象征性物体等
    * **抽象概念的视觉化**：当处理抽象主题时，必须通过具体视觉元素来体现：
      - "时间"：可以通过日晷、时钟、季节变化、光线变化等元素表现
      - "记忆"：可以通过旧照片、褪色物品、梦境般的视觉效果表现
      - "情感"：可以通过色彩、光影、人物表情、环境氛围等元素表现

3.  **输出格式：**
    * 必须且仅输出标准的JSON格式，不要包含任何Markdown标记（如 \`\`\`json ）。
**JSON结构模版（可在 outline 每个镜头中额外补充字段，以增强稳定性）：**
{
    "analysis": "详细分析受众画像（如：Z世代、科技爱好者）及整体视频调性（如：赛博朋克、极简主义、胶片感），包括主题的深层含义和附加内容的转化策略。",
    "creative_strategy": "视频的创意方向和视觉语言规划，包括如何通过镜头语言表达主题的深层含义。",
    "outline": [
        {
            "id": ${index + 1},
            "summary": "必须使用结构化格式输出： [主体]... + [环境/背景细节(≥8个元素，含前/中/远景)]... + [关键动作/动态(≥2)]... + [运镜/镜头语言(含景深/焦点)]... + [光影/材质(≥4)]... + [主题锚点符号(≥2)]... + [情感暗示]... + [场景时间线(当涉及多个场景时必须明确时间线与场景切换)]...",
            "style_guide": "该镜头的具体视觉风格（必须含：核心色调、对比关系、光影方式、镜头节奏；例如：冷色为主+金色点缀、体积光、微距慢推、胶片颗粒）。",
            "duration": ${duration},
            "concept_link": "该镜头如何体现主题的核心概念/锚点符号，以及与已生成分镜的继承与递进（必须写清楚继承了什么、新增了什么）",
            "theme_anchor": "本镜头的主题锚点词（1句，必须强相关于主题）",
            "background_elements": ["至少8个具体背景元素（字符串数组，尽量覆盖前/中/远景）"],
            "recurring_motifs": ["需要在后续镜头重复出现的母题/符号（2-4个）"],
            "scene_type": "场景类型（室内/室外/过渡/概念）",
            "scene_transition": "场景切换描述（包括时间点和过渡元素）",
            "scene_timeline": "场景时间线（如'0-3秒：室内场景'）"
        }

    ]

}`;

    const resultRaw = await callDeepSeek(apiKey, systemPrompt, "开始策划", 4096, 600000, abortSignal);
    const result = parseJsonResult(resultRaw);

    // 只在首次生成时写入全局策划（避免后续生成覆盖用户已编辑的策划内容）
    if (!globalConcept) {
        globalConcept = [result.analysis, result.creative_strategy].filter(Boolean).join('\n\n');
    }

    // 兼容 outline 可能返回 1 个或多个条目：尽量选中当前 index 对应的那一个
    const outlineArr = Array.isArray(result.outline) ? result.outline : [];
    const picked =
        outlineArr.find(s => String(s.id) === String(index + 1)) ||
        outlineArr[0] ||
        null;

    if (!picked) {
        throw new Error('模型返回内容缺少 outline 分镜数据');
    }

    const newScene = {
        ...picked,
        video_prompt: null, // 待生成
        voiceover: null,    // 待生成
        description: null,  // 待生成
        detail_generated: false,
        regen_hint: ''      // 重新生成提示的自定义要求
    };

    // 追加而不是覆盖：保证“生成下一个分镜”按顺序累积
    globalScenes.push(newScene);
    return newScene;
}

// ==========================================
// Step 2: 分镜细化 (Detailing)
// ==========================================

// 新增：编辑回调函数
function updateSceneSummary(index, value) { globalScenes[index].summary = value; }
function updateSceneStyle(index, value) { globalScenes[index].style_guide = value; }
function updateScenePrompt(index, value) { globalScenes[index].video_prompt = value; }
function updateSceneHint(index, value) { globalScenes[index].regen_hint = value; }

// 生成下一个分镜的UI
function renderNextSceneUI() {
    const container = document.getElementById('storyboardContainer');
    const index = globalScenes.length - 1; // 最后一个分镜
    const scene = globalScenes[index];
    
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.id = `scene-card-${index}`;
    
    // 初始状态：只显示简述和大纲
    card.innerHTML = `
        <div class="scene-header">
            <span class="scene-title">#${index + 1} ${scene.style_guide || '镜头'}</span>
            <span class="scene-duration"><i class="bi bi-clock"></i> ${scene.duration}s</span>
        </div>
        
        <!-- 简略大纲区 -->
        <div class="mb-3 border-bottom pb-2">
            <div class="d-flex justify-content-between align-items-start mb-1">
                <span class="badge bg-light text-dark border">规划</span>
                <div>
                    <button class="btn btn-link btn-sm p-0 text-decoration-none me-2" id="optimize-toggle-${index}" onclick="toggleOptimizePanel(${index})" title="打开润色面板">
                        <i class="bi bi-stars text-primary"></i> 润色/修改
                    </button>
                </div>
            </div>
            <div class="p-2 bg-light border rounded editable-summary mb-2" id="summary-content-${index}" contenteditable="true" onblur="updateSceneSummary(${index}, this.innerText)">${escapeHtml(scene.summary || '')}</div>
            
            <!-- 润色面板 (默认隐藏) -->
            <div id="optimize-panel-${index}" class="card card-body bg-light mb-2 d-none p-2" style="font-size: 0.9rem;">
                <label class="form-label small fw-bold mb-1">修改指令（可选）</label>
                <div class="input-group input-group-sm mb-2">
                    <input type="text" class="form-control" id="optimize-input-${index}" placeholder="例如：改成下雪天，保留猫的主体，增加赛博朋克光效...">
                    <button class="btn btn-primary" id="optimize-btn-${index}" onclick="optimizeSceneSummary(${index})">
                        <i class="bi bi-magic"></i> 执行润色
                    </button>
                    <button class="btn btn-outline-secondary" id="undo-optimize-btn-${index}" onclick="undoOptimizeSummary(${index})" style="display:none" title="撤销上次修改">
                        <i class="bi bi-arrow-counterclockwise"></i> 撤销
                    </button>
                </div>
                <small class="text-muted d-block">AI 将根据指令重写规划，并强制保持 [主体]+[环境]+[动作] 的结构化格式。</small>
            </div>

            <div class="mt-1 small text-muted">风格：<span class="editable-style" contenteditable="true" onblur="updateSceneStyle(${index}, this.innerText)">${escapeHtml(scene.style_guide || '无')}</span></div>
        </div>

        <!-- 详细脚本区 (待生成) -->
        <div id="scene-detail-area-${index}">
            <div class="text-center py-3">
                <button class="btn btn-outline-primary btn-sm" onclick="generateSingleSceneDetail(${index})">
                    <i class="bi bi-magic"></i> 生成详细脚本 (Prompt & 旁白)
                </button>
            </div>
        </div>

        <!-- 视频结果区 (隐藏) -->
        <div id="video-result-area-${index}" class="video-result-container d-none">
             <div class="d-flex justify-content-between align-items-center">
                <div><span class="badge bg-secondary" id="video-status-${index}">未生成</span></div>
                <button class="btn btn-sm btn-primary" onclick="generateSingleVideo(${index})">
                    <i class="bi bi-play-fill"></i> 生成视频
                </button>
            </div>
            <div class="mt-3 d-none" id="video-content-${index}"></div>
        </div>
    `;
    container.appendChild(card);
}

// 渲染分镜UI（用于初始渲染和后续添加）
function renderStep2_UI() {
    document.getElementById('resultSection').classList.remove('d-none');
    
    // 渲染分析结果
    document.getElementById('conceptAnalysis').innerHTML =
        `<strong>策划思路：</strong>${formatTextToHtml(globalConcept)}`;
    
    // 渲染所有已生成分镜
    const container = document.getElementById('storyboardContainer');
    container.innerHTML = '';
    
    globalScenes.forEach((scene, index) => {
        const card = document.createElement('div');
        card.className = 'scene-card';
        card.id = `scene-card-${index}`;
        
        // 初始状态：只显示简述和大纲
        card.innerHTML = `
            <div class="scene-header">
                <span class="scene-title">#${index + 1} ${scene.style_guide || '镜头'}</span>
                <span class="scene-duration"><i class="bi bi-clock"></i> ${scene.duration}s</span>
            </div>
            
        <!-- 简略大纲区 -->
        <div class="mb-3 border-bottom pb-2">
            <div class="d-flex justify-content-between align-items-start mb-1">
                <span class="badge bg-light text-dark border">规划</span>
                <div>
                    <button class="btn btn-link btn-sm p-0 text-decoration-none me-2" id="optimize-toggle-${index}" onclick="toggleOptimizePanel(${index})" title="打开润色面板">
                        <i class="bi bi-stars text-primary"></i> 润色/修改
                    </button>
                </div>
            </div>
            <div class="p-2 bg-light border rounded editable-summary mb-2" id="summary-content-${index}" contenteditable="true" onblur="updateSceneSummary(${index}, this.innerText)">${escapeHtml(scene.summary || '')}</div>
            
            <!-- 润色面板 (默认隐藏) -->
            <div id="optimize-panel-${index}" class="card card-body bg-light mb-2 d-none p-2" style="font-size: 0.9rem;">
                <label class="form-label small fw-bold mb-1">修改指令（可选）</label>
                <div class="input-group input-group-sm mb-2">
                    <input type="text" class="form-control" id="optimize-input-${index}" placeholder="例如：改成下雪天，保留猫的主体，增加赛博朋克光效...">
                    <button class="btn btn-primary" id="optimize-btn-${index}" onclick="optimizeSceneSummary(${index})">
                        <i class="bi bi-magic"></i> 执行润色
                    </button>
                    <button class="btn btn-outline-secondary" id="undo-optimize-btn-${index}" onclick="undoOptimizeSummary(${index})" style="display:none" title="撤销上次修改">
                        <i class="bi bi-arrow-counterclockwise"></i> 撤销
                    </button>
                </div>
                <small class="text-muted d-block">AI 将根据指令重写规划，并强制保持 [主体]+[环境]+[动作] 的结构化格式。</small>
            </div>

            <div class="mt-1 small text-muted">风格：<span class="editable-style" contenteditable="true" onblur="updateSceneStyle(${index}, this.innerText)">${escapeHtml(scene.style_guide || '无')}</span></div>
        </div>

            <!-- 详细脚本区 (待生成) -->
            <div id="scene-detail-area-${index}">
                <div class="text-center py-3">
                    <button class="btn btn-outline-primary btn-sm" onclick="generateSingleSceneDetail(${index})">
                        <i class="bi bi-magic"></i> 生成详细脚本 (Prompt & 旁白)
                    </button>
                </div>
            </div>

            <!-- 视频结果区 (隐藏) -->
            <div id="video-result-area-${index}" class="video-result-container d-none">
                 <div class="d-flex justify-content-between align-items-center">
                    <div><span class="badge bg-secondary" id="video-status-${index}">未生成</span></div>
                    <button class="btn btn-sm btn-primary" onclick="generateSingleVideo(${index})">
                        <i class="bi bi-play-fill"></i> 生成视频
                    </button>
                </div>
                <div class="mt-3 d-none" id="video-content-${index}"></div>
            </div>
        `;
        container.appendChild(card);
    });

    // 激活 Step 2 状态
    document.getElementById('step2-num').classList.add('active');

    // 根据当前分镜数量，更新“生成下一个分镜”按钮状态（避免上一轮禁用状态残留）
    const sceneCount = parseInt(document.getElementById('sceneCount')?.value || '0');
    const nextBtn = document.getElementById('generateNextSceneBtn');
    if (nextBtn) {
        if (sceneCount > 0 && globalScenes.length >= sceneCount) {
            nextBtn.disabled = true;
            nextBtn.innerHTML = '<i class="bi bi-check"></i> 所有分镜已生成';
            
            // 显示“一键生成所有脚本”按钮
            const batchScriptBtn = document.getElementById('batchDetailBtn');
            if (batchScriptBtn) batchScriptBtn.style.display = 'inline-block';
        } else {
            nextBtn.disabled = false;
            nextBtn.innerHTML = '<i class="bi bi-plus"></i> 生成下一个分镜';
        }
    }
}

// 生成下一个分镜
async function generateNextScene() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const topic = document.getElementById('topic').value.trim();
    const sceneCount = parseInt(document.getElementById('sceneCount').value);
    const sceneDuration = parseInt(document.getElementById('sceneDuration').value);
    
    if (!apiKey) { showError('请输入 DeepSeek API Key'); return; }
    if (!topic) { showError('请输入视频主题'); return; }
    
    const currentSceneIndex = globalScenes.length;
    
    if (currentSceneIndex >= sceneCount) {
        alert('已生成所有分镜！');
        return;
    }
    
    // Step2 生成期间显示进度区，避免用户误以为“点了没反应”
    const progressSection = document.getElementById('progressSection');
    if (progressSection) progressSection.classList.remove('d-none');
    const nextBtn = document.getElementById('generateNextSceneBtn');
    if (nextBtn) nextBtn.disabled = true;

    updateProgress(30 + (currentSceneIndex * 70 / sceneCount), `正在生成第 ${currentSceneIndex + 1} 个分镜...`, 1);
    
    try {
        const abortSignal = beginCancelableOp(`生成第 ${currentSceneIndex + 1} 个分镜`);
        await generateNextSceneData(apiKey, topic, sceneCount, sceneDuration, currentSceneIndex, abortSignal);
        renderNextSceneUI();
        
        // 检查是否已生成所有分镜
        if (globalScenes.length >= sceneCount) {
            document.getElementById('generateNextSceneBtn').disabled = true;
            document.getElementById('generateNextSceneBtn').innerHTML = '<i class="bi bi-check"></i> 所有分镜已生成';
            
            // 显示“一键生成所有脚本”按钮
            const batchScriptBtn = document.getElementById('batchDetailBtn');
            if (batchScriptBtn) batchScriptBtn.style.display = 'inline-block';
        }
        
    } catch (error) {
        console.error(error);
        if (String(error?.message || '').includes('已中断')) {
            showError('已中断');
        } else {
            showError('生成下一个分镜失败：' + error.message);
        }
    } finally {
        endCancelableOp();
        if (nextBtn && globalScenes.length < sceneCount) nextBtn.disabled = false;
        if (progressSection) progressSection.classList.add('d-none');
    }
}

/**
 * 生成单个分镜的详细脚本
 */
async function generateSingleSceneDetail(index, externalAbortSignal) {
    const apiKey = document.getElementById('apiKey').value.trim();
    const scene = globalScenes[index];
    const detailArea = document.getElementById(`scene-detail-area-${index}`);
    const topic = document.getElementById('topic').value.trim();
    const detailPreset = (document.getElementById('detailPreset')?.value || 'standard').trim();
    const narrationMode = (document.getElementById('narrationMode')?.value || 'on').trim();
    const videoRatio = (document.getElementById('videoRatio')?.value || '9:16').trim();

    // 动态分段策略：不再写死时间点，而是告诉 AI 总时长，让它自己规划
    const duration = Number(scene.duration || 5);
    const segmentHint = (() => {
        if (duration >= 15) return "建议分为 3-4 个时间节拍";
        if (duration >= 8) return "建议分为 2-3 个时间节拍";
        return "建议分为 2 个时间节拍";
    })();

    // UI Loading
    detailArea.innerHTML = `<div class="text-center text-muted small"><span class="spinner-border spinner-border-sm"></span> 正在编写脚本...</div>`;

    try {
        // 如果是批量细化传入 externalAbortSignal，则不要重复创建/覆盖全局可中断操作
        const abortSignal = externalAbortSignal || beginCancelableOp(`细化第 ${index + 1} 个分镜`);
        // 优化点：明确角色为“Prompt工程师”，并强调针对 CogVideoX 的优化逻辑
        const systemPrompt = `你是一位精通CogVideoX模型的AI视频Prompt工程师，同时也是电影摄影指导与分镜脚本师。你的任务是将“简单分镜描述”扩写为可直接用于生成高质量视频的脚本与英文Prompt。

**核心原则：**
1. **CogVideoX 偏好：** 模型更喜欢流畅的自然语言描述，而非单纯的关键词堆砌。
2. **动态优先：** 视频Prompt必须包含明确的“动作”或“运镜”描述，否则生成的视频会像PPT。
3. **视觉密度（重中之重）：** 视觉描述必须达到“显微镜级”精度。必须明确描述：**材质纹理**（如：粗糙的混凝土、丝绸般的水面）、**光影互动**（如：丁达尔效应、边缘轮廓光）、**环境粒子**（如：漂浮的尘埃、飞溅的火星）。
4. **中英完全对齐（铁律）：** 英文 video_prompt 必须是中文 description 的**像素级翻译**。中文里提到的每一个视觉细节（材质、动作、光影），英文里**必须**有对应的描述，**严禁漏译或简化**。
5. **可执行性：** 杜绝抽象形容词（如“氛围感”、“震撼”），必须转化为物理描述（如“烟雾缭绕”、“大广角仰拍”）。

**输入上下文：**
主题：${topic}
整体基调：${globalConcept}`;

        // 读取用户的额外要求
        const extra = (globalScenes[index].regen_hint || '').trim();

        const proRules = detailPreset === 'pro' ? `
【专业细节模式（必须遵守）】
1) **时间轴自主规划**：本镜头总时长为 ${duration}秒。请根据画面内容逻辑，自主规划时间轴（${segmentHint}），例如 "0s-3s", "3s-${duration}s" 等。
2) 输出必须包含“时间轴节拍”，每个节拍段落都要包含：
   - Visual（**视觉描述必须极度具体**：明确指出材质质感（如粗糙/光滑/湿润）、光影方向与色彩、粒子特效（烟雾/火星/灰尘）以及物体的物理状态。**拒绝**“好看的背景”这种空话，要写“墙纸剥落露出红砖的背景”。）
   - Camera（机位/镜头运动/景深变化，如“85mm镜头聚焦前景，背景虚化”）
   - Lighting（主光源方向、色温倾向、阴影与高光特征）
   - Micro details（至少3个：如水珠挂壁、尘埃漂浮、皮肤/鳞片微反光、蒸汽、纤维、划痕等）
   - Audio（环境音/音效，不要写“背景音乐很好听”这种空话）
 3) 画幅要求：${videoRatio}（竖屏/横屏请严格遵守）；强调“微距/近景质感”，给出镜头信息（如 85mm macro、f/2.8、浅景深）。
 4) **中英对齐**：英文 video_prompt 必须显式包含你规划的时间轴标记（如 "0s-3s:"），且**完美包含**上述 Visual/Camera/Lighting/Micro details 的所有内容。不要因为是英文就偷工减料。
5) 英文 video_prompt 必须更完整（不少于140英文词），并包含：主体外观细节、关键动作、环境细节、镜头运动、光影、材质、粒子/体积效果、转场/结尾状态、质量词。
6) 明确排除项：不要出现字幕/水印/Logo/文字；不要出现额外肢体或畸形；不要出现跳切抖动；避免“过度梦幻导致主体糊成一团”。
7) description 用中文写得像给导演/摄影/特效看的“可执行脚本”，不是给营销写的文案。
` : '';

        const narrationRule = narrationMode === 'off'
            ? '旁白要求：voiceover 返回空字符串 ""，只在 description 的 Audio 中写环境音/音效。'
            : `旁白要求：voiceover 为中文，尽量口语化但有画面感；按你规划的时间轴分段写，每段1-2句，避免太长。`;

        const userPrompt = `
**当前镜头参数：**
- 画面简述：${scene.summary}
- 风格指导：${scene.style_guide}
- 预设时长：${scene.duration}s

**生成要求：**

${proRules}

1. **Video Prompt 构建法则 (英文)：**
   请用自然语言写成一段（标准模式）或按时间轴分段（专业模式必须按自主规划的时间轴分段），确保画面丰富且稳定，必须包含：
   * **主体与外观细节**（材质、纹理、微瑕疵、反光）
   * **动作与动态**（关键动作 + 次要微动作 + 粒子/流体/体积效果）
   * **环境与背景**（空间深度、前中后景细节）
   * **镜头与光影**（机位、镜头运动、景深、主光/辅光/轮廓光）
   * **结尾状态/转场**（画面如何结束，为下一镜头留钩子）
   * **质量词**：结尾加上 "8k, cinematic, hyper-realistic, macro cinematography, exquisite textures, magical lighting, highly detailed, smooth motion, masterpiece".

2. **视觉展开：**
   * 严格结合"${scene.style_guide}"。例如若是"赛博朋克"，Prompt中需包含 "neon lights, rainy street, futuristic reflection"。

3. **旁白编写 (Voiceover)：**
   * 语调要符合"${globalConcept}"。
   * **字数控制：** ${scene.duration}秒的视频，旁白字数控制在 ${Math.ceil(scene.duration * 4)} 字以内，不要太长。
   * ${narrationRule}

${extra ? `4. **用户特别修正指令(最高优先级)：** ${extra}` : ''}

請输出JSON：
{
    "description": "详细的画面脚本(中文)。若为专业模式，必须包含你自主规划的时间轴分段与镜头/光影/材质细节。",
    "video_prompt": "符合CogVideoX标准的英文Prompt。专业模式下必须包含时间轴标记（如 0s-3s:），且字数不少于120英文词。",
    "voiceover": "中文旁白；若选择无旁白则返回空字符串\"\"。"
}`;

        const maxTokens = detailPreset === 'pro' ? 4096 : 2048;
        const timeoutMs = detailPreset === 'pro' ? 300000 : 120000;
        const resultRaw = await callDeepSeek(apiKey, systemPrompt, userPrompt, maxTokens, timeoutMs * 2, abortSignal);
        const result = parseJsonResult(resultRaw);

        // 专业模式下做一次“质量门槛”：如果英文Prompt仍然太短/没按时间轴输出，则自动修复一次
        const needRepair = (() => {
            if (detailPreset !== 'pro') return false;
            const vp = String(result.video_prompt || '');
            const words = countEnglishWords(vp);
            // 只要包含至少一个 "数字s - 数字s" 或 "数字s to 数字s" 的时间标记即可
            const hasTimeline = /\d+s\s*[-–to]\s*\d+s/i.test(vp);
            return words < 140 || !hasTimeline;
        })();

        if (needRepair) {
            const repairSystem = `你是一位严格的AI视频Prompt修复工程师。你只负责把“中文脚本”忠实转换为“按时间轴分段的英文 video_prompt”。必须与脚本内容一一对应，不允许泛化。`;
            const repairUser = `
请基于下面的中文脚本，输出一个新的 video_prompt（英文），必须按时间轴分段（显式写出时间标记，如 0s-xx:）。

硬性要求：
1) 英文内容必须与中文脚本的时间轴和细节描述完全对应。
2) 每段都要同步：主体外观细节、关键动作、环境细节、镜头运动、光影、材质/纹理、粒子/体积效果。
2) 必须排除：字幕/水印/Logo/文字、畸形肢体、跳切抖动。
3) 总英文词数不少于 160。
4) 仅输出 JSON，结构如下：
{
  "video_prompt": "..."
}

中文脚本如下：
${result.description || scene.summary || ''}`.trim();

            const repairedRaw = await callDeepSeek(apiKey, repairSystem, repairUser, 2048, 60000, abortSignal);
            const repaired = parseJsonResult(repairedRaw);
            if (repaired && repaired.video_prompt) {
                result.video_prompt = repaired.video_prompt;
            }
        }

        // 更新数据
        globalScenes[index].description = result.description;
        globalScenes[index].video_prompt = result.video_prompt;
        globalScenes[index].voiceover = result.voiceover;
        globalScenes[index].detail_generated = true;

        // 更新 UI
        renderSceneDetail(index);
        checkAllDetailsGenerated();

    } catch (e) {
        console.error(e);
        if (String(e?.message || '').includes('已中断')) {
            detailArea.innerHTML = `<div class="text-muted small">已中断 <button class="btn btn-link btn-sm" onclick="generateSingleSceneDetail(${index})">继续生成</button></div>`;
        } else {
            detailArea.innerHTML = `<div class="text-danger small">生成失败: ${e.message} <button class="btn btn-link btn-sm" onclick="generateSingleSceneDetail(${index})">重试</button></div>`;
        }
    } finally {
        if (!externalAbortSignal) endCancelableOp();
    }
}

function countEnglishWords(text) {
    return String(text)
        .replace(/[^A-Za-z0-9'\-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .length;
}

/**
 * 渲染单个分镜的详细内容
 */
function renderSceneDetail(index) {
    const scene = globalScenes[index];
    const detailArea = document.getElementById(`scene-detail-area-${index}`);
    const videoArea = document.getElementById(`video-result-area-${index}`);

    detailArea.innerHTML = `
        <div class="row">
            <div class="col-md-12 mb-2">
                <small class="text-muted">详细描述：</small> ${formatTextToHtml(scene.description || '')}
            </div>
            <div class="col-md-12 mb-2">
                 <small class="text-muted">旁白：</small> <span class="fst-italic text-secondary">"${escapeHtml(scene.voiceover || '')}"</span>
            </div>
            <div class="col-md-12">
                <div class="prompt-box">
                    <span class="badge bg-dark mb-1">PROMPT</span> 
                    <div contenteditable="true" class="editable-prompt" onblur="updateScenePrompt(${index}, this.innerText)">${formatTextToHtml(scene.video_prompt || '')}</div>
                    <button class="btn btn-sm btn-light border copy-btn" onclick="copyToClipboard(globalScenes[${index}].video_prompt)">
                        <i class="bi bi-clipboard"></i>
                    </button>
                </div>
            </div>
            <div class="col-md-12 text-end mt-2">
                 <button class="btn btn-sm btn-outline-secondary" onclick="generateSingleSceneDetail(${index})"><i class="bi bi-arrow-clockwise"></i> 重新生成脚本</button>
            </div>
            <div class="col-md-12 mt-2">
                 <label class="form-label small mb-1 text-muted">重新生成补充要求（可选）</label>
                 <textarea class="form-control form-control-sm" rows="2" id="scene-hint-${index}" oninput="updateSceneHint(${index}, this.value)" placeholder="例如：保持圣诞风，加上雪地、铃铛、橙色暖光">${scene.regen_hint || ''}</textarea>
            </div>
        </div>
    `;
    
    // 显示视频生成区域
    videoArea.classList.remove('d-none');
}

/**
 * 批量生成详情
 */
async function batchGenerateDetails() {
    const pendingIndexes = globalScenes
        .map((s, i) => s.detail_generated ? -1 : i)
        .filter(i => i !== -1);
    
    if (pendingIndexes.length === 0) {
        alert("所有分镜脚本已生成完毕！");
        return;
    }

    const abortSignal = beginCancelableOp('批量细化分镜');
    // 并发控制：为了效果好，我们一次并发3个，避免 QPS 限制
    const CONCURRENT = 3;
    try {
        for (let i = 0; i < pendingIndexes.length; i += CONCURRENT) {
            const chunk = pendingIndexes.slice(i, i + CONCURRENT);
            // generateSingleSceneDetail 使用同一个 abortSignal，中断会同时取消本批次
            await Promise.all(chunk.map(idx => generateSingleSceneDetail(idx, abortSignal)));
        }
    } finally {
        endCancelableOp();
    }
}

function checkAllDetailsGenerated() {
    const allDone = globalScenes.every(s => s.detail_generated);
    if (allDone) {
        document.getElementById('step2-num').classList.remove('active');
        document.getElementById('step2-num').classList.add('completed');
        document.getElementById('step2-num').innerHTML = '<i class="bi bi-check"></i>';
        
        // 显示批量生成视频按钮
        document.getElementById('generateAllVideosBtn').style.display = 'inline-block';
        document.getElementById('step3-num').classList.add('active');
    }
}

// ==========================================
// Step 3: 视频生成 (Action)
// ==========================================

async function generateSingleVideo(index) {
    const zhipuKey = document.getElementById('zhipuApiKey').value.trim();
    if (!zhipuKey) { alert('请输入智谱 AI API Key'); return; }

    const scene = globalScenes[index];
    if (!scene.detail_generated) { alert('请先生成分镜脚本！'); return; }

    const statusBadge = document.getElementById(`video-status-${index}`);
    const contentDiv = document.getElementById(`video-content-${index}`);
    const btn = document.querySelector(`#video-result-area-${index} button`);

    // UI 状态
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 提交中...';
    contentDiv.classList.remove('d-none');
    contentDiv.innerHTML = `<div class="progress mb-2" style="height: 5px;"><div class="progress-bar progress-bar-striped progress-bar-animated" style="width: 10%"></div></div><div class="text-muted small">提交任务...</div>`;
    statusBadge.className = 'badge bg-warning text-dark';
    statusBadge.innerText = '准备中';

    try {
        const token = generateJwtToken(zhipuKey);
        const taskId = await createVideoTask(token, scene.video_prompt);
        
        // 更新状态
        videoTasks[index] = { taskId, status: 'PROCESSING' };
        statusBadge.innerText = '生成中';
        contentDiv.innerHTML = `<div class="progress mb-2" style="height: 5px;"><div class="progress-bar progress-bar-striped progress-bar-animated bg-warning" style="width: 40%"></div></div><div class="text-muted small">AI渲染中 (2-5分钟)...</div>`;
        
        // 返回一个“完成Promise”，方便批量模式做真正的并发控制
        return pollVideoResult(token, taskId, index);

    } catch (e) {
        console.error(e);
        statusBadge.className = 'badge bg-danger';
        statusBadge.innerText = '失败';
        btn.disabled = false;
        btn.innerHTML = '重试';
        contentDiv.innerHTML = `<span class="text-danger small">${e.message}</span>`;
    }
}

async function generateAllVideos() {
    const zhipuKey = document.getElementById('zhipuApiKey').value.trim();
    if (!zhipuKey) { alert('请先输入智谱 AI API Key'); return; }

    const CONCURRENT_LIMIT = 2; // 视频生成并发稍微低一点，防止账号限流
    const pending = [];
    for (let i = 0; i < globalScenes.length; i++) {
        if (videoTasks[i] && (videoTasks[i].status === 'SUCCESS' || videoTasks[i].status === 'PROCESSING')) continue;
        pending.push(i);
    }
    if (pending.length === 0) return;

    let cursor = 0;
    const worker = async () => {
        while (cursor < pending.length) {
            const idx = pending[cursor++];
            await generateSingleVideo(idx);
        }
    };
    const workers = Array.from({ length: Math.min(CONCURRENT_LIMIT, pending.length) }, () => worker());
    await Promise.all(workers);
}

// ... (保留原有的 generateJwtToken, createVideoTask, pollVideoResult, updateVideoUI, updateProgress 等辅助函数) ...
// 下面是需要保留的辅助函数，为了完整性我再次列出，确保没有丢失

function generateJwtToken(apiKey) {
    try {
        const [id, secret] = apiKey.split(".");
        if (!id || !secret) throw new Error("API Key 格式不正确");
        const payload = { api_key: id, exp: Date.now() + 3600 * 1000, timestamp: Date.now() };
        const header = { alg: "HS256", sign_type: "SIGN" };
        return KJUR.jws.JWS.sign("HS256", JSON.stringify(header), JSON.stringify(payload), secret);
    } catch (e) { throw new Error("Token error: " + e.message); }
}

// 切换润色面板显示
function toggleOptimizePanel(index) {
    const panel = document.getElementById(`optimize-panel-${index}`);
    if (panel) {
        panel.classList.toggle('d-none');
        // 如果面板已打开且有备份，显示撤销按钮
        const undoBtn = document.getElementById(`undo-optimize-btn-${index}`);
        if (undoBtn) {
            undoBtn.style.display = globalScenes[index].lastSummary ? 'inline-block' : 'none';
        }
    }
}

// 存储上次的创意内容以便撤销
let lastTopicContent = null;

// 切换创意优化面板显示
function toggleTopicOptimizePanel() {
    const panel = document.getElementById('topic-optimize-panel');
    panel.classList.toggle('d-none');
    
    // 如果有历史记录，显示撤销按钮
    const undoBtn = document.getElementById('undo-topic-btn');
    if (undoBtn) {
        undoBtn.style.display = lastTopicContent ? 'inline-block' : 'none';
    }
}

// 撤销创意优化
function undoOptimizeTopic() {
    if (lastTopicContent !== null) {
        const topicInput = document.getElementById('topic');
        topicInput.value = lastTopicContent;
        
        // 闪烁提示
        topicInput.classList.add('bg-warning', 'bg-opacity-10');
        setTimeout(() => topicInput.classList.remove('bg-warning', 'bg-opacity-10'), 500);
        
        // 隐藏撤销按钮（单步撤销）
        lastTopicContent = null;
        document.getElementById('undo-topic-btn').style.display = 'none';
    }
}

// 优化/扩写视频创意
async function optimizeTopic() {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) { alert('请先输入 DeepSeek API Key'); return; }

    const topicInput = document.getElementById('topic');
    const rawContent = topicInput.value; // 获取输入框内的完整文本
    const instructionInput = document.getElementById('topic-optimize-input');
    const instruction = instructionInput.value.trim();

    // 1. 智能提取：分离“用户主题”
    let currentTopic = rawContent;
    
    // 尝试匹配已生成的格式，提取 **视频主题** 后的内容
    // 匹配规则：找 "**视频主题**" 或 "视频主题：" 开头，直到遇到下一个 "**" 或结束
    const themeMatch = rawContent.match(/(?:\*\*视频主题\*\*|视频主题)[:：]?\s*([\s\S]*?)(\n\*\*|\n\n|$)/);
    if (themeMatch && themeMatch[1]) {
        currentTopic = themeMatch[1].trim();
    } else {
        // 旧逻辑：截取 AI 关键词之前的部分
        const aiKeywords = [
            '**画面风格**', '画面风格：', '镜头设计：', '人物要求：', '屋内设计：', '整体要求：',
            '视觉风格：', '核心创意：', '主体与场景要求：'
        ];
        let splitIndex = -1;
        for (const kw of aiKeywords) {
            const idx = rawContent.indexOf(kw);
            if (idx !== -1) {
                if (splitIndex === -1 || idx < splitIndex) splitIndex = idx;
            }
        }
        if (splitIndex !== -1) {
            currentTopic = rawContent.substring(0, splitIndex).trim();
        }
    }

    // 只要有输入内容或者有指令即可
    if (!currentTopic && !instruction) {
        alert('请先输入一些基础想法或优化指令');
        return;
    }

    const btn = document.getElementById('do-topic-optimize-btn');
    const undoBtn = document.getElementById('undo-topic-btn');
    const originalIcon = btn.innerHTML;
    
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 规划中...';

    try {
        const abortSignal = beginCancelableOp('优化视频创意');

        // 备份当前完整内容以便撤销
        lastTopicContent = rawContent;

        const systemPrompt = `你是一位AI视频制作架构师。你的任务是将用户输入的“核心主题”重构为一份**完整、专业、结构化**的视频策划方案。
这不仅是给用户看的，更是给后续AI生成环节（分镜、视频生成）使用的**标准执行单**。

**请严格遵守以下输出格式（直接输出全部内容，覆盖原文本）：**
**视频主题**：[在此处保留并优化用户的主题，保持核心立意不变]
**画面风格**：[描述整体画风、色调、光影质感。例如：“偏写实风格，低饱和度暖光，电影胶片质感”]
**镜头设计**：
- [条目化列出运镜逻辑。例如：“采用第一人称视角（FPV）...”]
- [例如：“镜头由远及近，平稳推拉...”]
**主体与场景细节**：
- [描述主要人物或核心主体特征]
- [描述环境背景、关键道具、必须出现的细节（堆叠名词）]
**整体要求**：
- [描述视频节奏、情感基调]
- [避坑指南（如避免变形、避免文字水印等）]
**原则**：
1. **全量输出**：输出结果必须包含“**视频主题**”这一项，且放在第一行。
2. **指令清晰**：多用“采用...”、“呈现...”、“聚焦...”等动词。
3. **细节丰富**：不要写空洞的形容词，要写画面里具体能看到什么。`;

        const userPrompt = `
核心主题：${currentTopic || '（用户未提供，请基于下方指令自由发挥）'}
${instruction ? `额外指令/偏好：${instruction}` : ''}

请输出完整的策划方案：`;

        const optimizedText = await callDeepSeek(apiKey, systemPrompt, userPrompt, 1024, 60000, abortSignal);
        
        // 更新内容
        const cleanText = optimizedText.replace(/^["']|["']$/g, '').trim(); // 去除可能的首尾引号
        
        // 覆盖回填：直接使用 AI 返回的完整内容（包含主题+细节），实现“修改”而非“追加”
        topicInput.value = cleanText;

        // 成功提示动画
        topicInput.classList.add('bg-success', 'bg-opacity-10');
        setTimeout(() => topicInput.classList.remove('bg-success', 'bg-opacity-10'), 500);

        // 显示撤销按钮
        if (undoBtn) undoBtn.style.display = 'inline-block';

    } catch (e) {
        console.error(e);
        if (!String(e?.message).includes('已中断')) {
            alert('优化失败：' + e.message);
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalIcon;
        endCancelableOp();
    }
}

async function optimizeSceneSummary(index) {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) { alert('请先输入 DeepSeek API Key'); return; }

    const scene = globalScenes[index];
    const currentSummary = scene.summary;
    const userInput = document.getElementById(`optimize-input-${index}`)?.value.trim() || '';
    
    const btn = document.getElementById(`optimize-btn-${index}`);
    const summaryDiv = document.getElementById(`summary-content-${index}`);
    const undoBtn = document.getElementById(`undo-optimize-btn-${index}`);

    // UI Loading
    const originalIcon = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    summaryDiv.classList.add('opacity-50');

    try {
        const abortSignal = beginCancelableOp(`润色第 ${index + 1} 个分镜规划`);

        // 备份当前状态以便撤销
        globalScenes[index].lastSummary = currentSummary;

        const systemPrompt = `你是一位专业电影分镜师。你的任务是根据用户的【修改指令】对原有的【分镜规划】进行**增量式微调**。

**核心原则（严格执行）：**
1. **基于原内容优化**：必须以原规划为基础，保留所有未被修改的精彩细节（如主体特征、特定环境元素、光影氛围）。**严禁**直接用新指令替换全文。
2. **智能融合**：将用户的新指令（如“增加内景”、“改成下雪”）自然地衔接或融入到原有描述中，确保逻辑通顺。
3. **结构保持**：输出必须严格遵循格式：
   [主体] ... + [环境/背景] ... + [关键动作] ... + [运镜/光影] ...
4. **细节增强**：在融合新指令时，自动补充相关的视觉细节（材质、光影、动态），使画面感更强。


**禁止项**：
- 禁止因为一个小指令就丢失原有的核心画面信息。
- 禁止输出“好的”、“已修改”等无关文字。`;

        const userPrompt = `**原规划内容（基础）：**
${currentSummary}

**修改指令（增量调整）：**
${userInput || '请增强画面细节和镜头感，保持原意不变。'}

**请输出修改后的完整规划（保留方括号结构）：**`;
        
        // 使用较短的 token 和超时，因为只生成一段话
        const optimizedText = await callDeepSeek(apiKey, systemPrompt, userPrompt, 1024, 60000, abortSignal);
        
        // 更新数据和UI
        const cleanText = optimizedText.replace(/^["']|["']$/g, '').trim(); // 去除可能的首尾引号
        updateSceneSummary(index, cleanText);
        summaryDiv.innerText = cleanText;
        
        // 闪烁一下提示成功
        summaryDiv.classList.remove('opacity-50');
        summaryDiv.style.backgroundColor = '#d1e7dd';
        setTimeout(() => { summaryDiv.style.backgroundColor = ''; }, 500);

        // 显示撤销按钮
        if (undoBtn) undoBtn.style.display = 'inline-block';

    } catch (e) {
        console.error(e);
        if (!String(e?.message).includes('已中断')) {
            alert('润色失败：' + e.message);
        }
        summaryDiv.classList.remove('opacity-50');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalIcon;
        endCancelableOp();
    }
}

function undoOptimizeSummary(index) {
    const scene = globalScenes[index];
    if (scene.lastSummary) {
        updateSceneSummary(index, scene.lastSummary);
        const summaryDiv = document.getElementById(`summary-content-${index}`);
        if (summaryDiv) {
            summaryDiv.innerText = scene.lastSummary;
            summaryDiv.style.backgroundColor = '#fff3cd'; // 黄色闪烁提示撤销
            setTimeout(() => { summaryDiv.style.backgroundColor = ''; }, 500);
        }
        // 撤销后清空备份，避免无限撤销（或者保留以支持反复横跳，这里选择保留）
        // scene.lastSummary = null; 
        
        // 隐藏撤销按钮（如果只支持单步撤销，这里可以隐藏；如果支持反复切换，则保留）
        const undoBtn = document.getElementById(`undo-optimize-btn-${index}`);
        if (undoBtn) undoBtn.style.display = 'none';
        
        // 清除备份，确保只能撤销一次（单步撤销逻辑）
        delete globalScenes[index].lastSummary;
    }
}

async function createVideoTask(token, prompt) {
    const url = `${ZHIPU_BASE_URL}/videos/generations`;
    const videoRatio = (document.getElementById('videoRatio')?.value || '9:16').trim();
    const size = videoRatio === '16:9' ? "1920x1080" : "1080x1920"; // 默认为 9:16 竖屏

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: "cogvideox-3",
            prompt: prompt,
            quality: "quality",
            with_audio: true,
            size: size,
            fps: 30
        })
    });
    if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || "任务失败"); }
    const data = await response.json();
    return data.id;
}

async function pollVideoResult(token, taskId, index) {
    const url = `${ZHIPU_BASE_URL}/async-result/${taskId}`;
    let retryCount = 0;
    
    // 优化轮询策略：缩短间隔至 3秒，提升感知速度
    return await new Promise((resolve) => {
        const intervalId = setInterval(async () => {
            try {
                if (retryCount >= 400) { // 约 20分钟超时 (400 * 3s)
                    clearInterval(intervalId);
                    updateVideoUI(index, 'TIMEOUT', null);
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!res.ok) return;

                const data = await res.json();
                if (data.task_status === 'SUCCESS') {
                    clearInterval(intervalId);
                    const videoUrl = data.video_result?.[0]?.url || null;
                    updateVideoUI(index, 'SUCCESS', videoUrl);
                    resolve({ status: 'SUCCESS', url: videoUrl });
                } else if (data.task_status === 'FAIL') {
                    clearInterval(intervalId);
                    updateVideoUI(index, 'FAIL', null);
                    resolve({ status: 'FAIL', url: null });
                }
                retryCount++;
            } catch (e) {
                console.error(e);
            }
        }, 3000); // 3秒轮询一次
    });
}

function updateVideoUI(index, status, url) {
    const statusBadge = document.getElementById(`video-status-${index}`);
    const contentDiv = document.getElementById(`video-content-${index}`);
    const btn = document.querySelector(`#video-result-area-${index} button`);
    
    if (status === 'SUCCESS') {
        statusBadge.className = 'badge bg-success'; statusBadge.innerText = '完成';
        btn.innerHTML = '<i class="bi bi-check-lg"></i> 完成';
        contentDiv.innerHTML = `<video src="${url}" controls class="w-100 rounded shadow-sm"></video><div class="mt-2 text-end"><a href="${url}" download="scene_${index}.mp4" class="btn btn-sm btn-outline-success"><i class="bi bi-download"></i></a></div>`;
    } else if (status === 'FAIL') {
        statusBadge.className = 'badge bg-danger'; statusBadge.innerText = '失败';
        btn.disabled = false; btn.innerHTML = '重试';
        contentDiv.innerHTML = `<span class="text-danger">生成失败</span>`;
    } else if (status === 'TIMEOUT') {
        statusBadge.className = 'badge bg-secondary'; statusBadge.innerText = '超时';
    }

    // 同步任务状态，方便批量逻辑判断
    if (videoTasks[index]) {
        videoTasks[index].status = status;
        videoTasks[index].url = url || null;
    }
}

// DeepSeek API Call Helper
async function callDeepSeek(apiKey, systemPrompt, userPrompt, maxTokens = 4096, timeoutMs, externalAbortSignal) {
    let endpoint = currentApiConfig.baseUrl.includes('paratera') ? `${currentApiConfig.baseUrl}/v1/chat/completions` : 'https://api.deepseek.com/chat/completions';
    
    // 更新API状态UI
    const statusBadge = document.getElementById('apiStatusBadge');
    if (statusBadge) {
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'badge bg-warning text-dark';
        statusBadge.innerHTML = '<span class="spinner-grow spinner-grow-sm" style="width: 0.5rem; height: 0.5rem;"></span> 请求中...';
    }

    let timer = null;
    try {
        const baseBody = {
            model: currentApiConfig.model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7,
            max_tokens: maxTokens,
            stream: false
        };

        const doFetch = async (withResponseFormat) => {
            const controller = new AbortController();
            // 外部中断（用户点击“中断”）时，联动取消本次请求
            if (externalAbortSignal) {
                if (externalAbortSignal.aborted) {
                    controller.abort();
                } else {
                    externalAbortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }
            }
            const ms = typeof timeoutMs === 'number'
                ? timeoutMs
                : (maxTokens >= 4096 ? 480000 : 180000); // 默认：长输出给更长超时（加倍）
            timer = setTimeout(() => controller.abort(), ms);

            const body = withResponseFormat
                ? { ...baseBody, response_format: { type: 'json_object' } }
                : baseBody;

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(body)
            });
            clearTimeout(timer);
            timer = null;
            return res;
        };

        // 优先请求“严格 JSON”，如果网关不支持则自动降级重试
        let response = await doFetch(true);
        if (!response.ok) {
            const errText = await response.text();
            const maybeUnsupported = (response.status === 400 || response.status === 422) &&
                String(errText).toLowerCase().includes('response_format');
            if (maybeUnsupported) {
                response = await doFetch(false);
                if (!response.ok) {
                    const err2 = await response.text();
                    throw new Error(`API Error: ${response.status} - ${err2}`);
                }
            } else {
                throw new Error(`API Error: ${response.status} - ${errText}`);
            }
        }
        
        const data = await response.json();
        
        // 请求成功
        if (statusBadge) {
            statusBadge.className = 'badge bg-success';
            statusBadge.innerText = '调用成功';
            setTimeout(() => { statusBadge.style.display = 'none'; }, 3000);
        }

        return data.choices[0].message.content;

    } catch (error) {
        // 请求失败
        if (statusBadge) {
            statusBadge.className = 'badge bg-danger';
            statusBadge.innerText = '调用失败';
        }
        if (error?.name === 'AbortError') {
            if (externalAbortSignal?.aborted) {
                throw new Error('已中断');
            }
            throw new Error('请求超时：网络或网关响应过慢，请稍后重试（专业细节模式会更慢）');
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function parseJsonResult(content) {
    // 1. 尝试提取 JSON 文本块
    let jsonStr = content;
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1];
    } else {
        const start = content.search(/[{[]/);
        const end = Math.max(content.lastIndexOf('}'), content.lastIndexOf(']')) + 1;
        if (start !== -1 && end !== -1) {
            jsonStr = content.substring(start, end);
        }
    }

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("标准 JSON 解析失败，尝试容错修复...", e);
        
        // 1. 基础清洗：去除换行符，防 Unterminated string
        let fixedContent = jsonStr.replace(/[\r\n]/g, " ");

        // 2. 进阶清洗：修复中文引号 (结构性)
        // 修复左引号：前面是 : [ , { 的
        fixedContent = fixedContent.replace(/([:\[,{]\s*)“/g, '$1"');
        // 修复右引号：后面是 : , ] } 的
        fixedContent = fixedContent.replace(/”(\s*[:,\]}])/g, '"$1');

        try {
            return JSON.parse(fixedContent);
        } catch (e2) {}

        // 3. 最终尝试：宽松模式 (new Function)
        if (!/function|return|window|document|alert|eval/.test(fixedContent)) {
            try {
                return new Function("return " + fixedContent)();
            } catch (e3) {}
        }

        // 如果仍失败，抛出原始错误
        throw e;
    }
}

function formatTextToHtml(text) {
    if (!text) return '';
    return escapeHtml(String(text)).replace(/\n/g, '<br>');
}

function escapeHtml(str) {
    return str
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function updateProgress(percent, text, step, isCompleted = false) {
    const bar = document.getElementById('progressBar');
    const status = document.getElementById('statusText');
    if(bar) bar.style.width = `${percent}%`;
    if(status) status.innerText = text;
    
    if (step) {
        const stepNum = document.getElementById(`step${step}-num`);
        if (stepNum) {
            stepNum.classList.add('active');
            if (isCompleted) {
                stepNum.classList.remove('active');
                stepNum.classList.add('completed');
                stepNum.innerHTML = '<i class="bi bi-check"></i>';
            }
        }
    }
}

function resetSteps() {
    for (let i = 1; i <= 3; i++) {
        const stepNum = document.getElementById(`step${i}-num`);
        if (stepNum) {
            stepNum.className = 'step-number';
            stepNum.innerText = i;
            stepNum.classList.remove('active', 'completed');
        }
    }
}

function showError(msg) {
    document.getElementById('errorAlert').classList.remove('d-none');
    document.getElementById('errorMessage').innerText = msg;
    document.getElementById('progressSection').classList.add('d-none');
}
function hideError() { document.getElementById('errorAlert').classList.add('d-none'); }
function copyToClipboard(text) { navigator.clipboard.writeText(text); }
function exportResult() {
    if (!globalScenes) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({concept: globalConcept, scenes: globalScenes}, null, 2));
    const a = document.createElement('a');
    a.href = dataStr; a.download = "storyboard_export.json";
    document.body.appendChild(a); a.click(); a.remove();
}
