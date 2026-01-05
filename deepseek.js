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
        model: 'DeepSeek-V3.2-Exp',
        name: '第三方API',
        models: [
            { id: 'DeepSeek-V3.2', name: 'DeepSeek-V3.2 (默认)' },
            { id: 'DeepSeek-V3.2-Exp', name: 'DeepSeek-V3.2-Exp (实验版)' },
            { id: 'DeepSeek-V3.1', name: 'DeepSeek-V3.1 (极速)' }
        ]
    }
};

const ZHIPU_BASE_URL = "https://zhipu-proxy.1963087187.workers.dev";
const VEO_BASE_URL = "https://api.cqtai.com/api/cqt/generator/veo";  // Veo生成端点（正确）
const VEO_INFO_URL = "https://api.cqtai.com/api/cqt/info/veo";  // Veo查询端点
const NANO_BASE_URL = "https://api.cqtai.com/api/cqt/generator/nano";  // Nano图片生成端点
const NANO_INFO_URL = "https://api.cqtai.com/api/cqt/info/nano";  // Nano查询端点

// 全局状态
let currentApiConfig = API_CONFIG.thirdParty;
let globalConcept = null;   // 存储策划大纲
let globalSeriesAnchor = null;   // 存储系列共同锚点（系列视频的统一特征）
let globalScenes = [];      // 存储分镜列表
let videoTasks = {};        // 视频任务状态
let imageTasks = {};        // 图片任务状态（文生图）
let currentMainMode = 'video';  // 当前主模式：'video' 或 'image'

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

    // 5. 视频平台切换
    const zhipuPlatform = document.getElementById('zhipuPlatform');
    const veoPlatform = document.getElementById('veoPlatform');
    const zhipuSettings = document.getElementById('zhipuSettings');
    const veoSettings = document.getElementById('veoSettings');

    const updateVideoPlatform = () => {
        if (zhipuPlatform.checked) {
            zhipuSettings.classList.remove('d-none');
            veoSettings.classList.add('d-none');
        } else {
            zhipuSettings.classList.add('d-none');
            veoSettings.classList.remove('d-none');
        }
    };

    zhipuPlatform.addEventListener('change', updateVideoPlatform);
    veoPlatform.addEventListener('change', updateVideoPlatform);
    // 初始化时，默认选中Veo（根据HTML中的checked属性）
    updateVideoPlatform();

    // 6. 主模式切换（视频/图片）
    const videoMode = document.getElementById('videoMode');
    const imageMode = document.getElementById('imageMode');
    const imageGenerationSection = document.getElementById('imageGenerationSection');
    const imageResultSection = document.getElementById('imageResultSection');
    const topicSection = document.querySelector('section.card:nth-of-type(2)'); // 主题设置区域

    const updateMainMode = () => {
        if (videoMode.checked) {
            currentMainMode = 'video';
            // 显示视频生成相关界面
            topicSection.classList.remove('d-none');
            imageGenerationSection.classList.add('d-none');
            imageResultSection.classList.add('d-none');
            document.getElementById('resultSection').classList.remove('d-none');
        } else if (imageMode.checked) {
            currentMainMode = 'image';
            // 显示文生图相关界面
            topicSection.classList.add('d-none');
            imageGenerationSection.classList.remove('d-none');
            document.getElementById('resultSection').classList.add('d-none');
        }
    };

    videoMode.addEventListener('change', updateMainMode);
    imageMode.addEventListener('change', updateMainMode);

    // 7. CQTAI平台切换（Veo/Nano）
    const cqtaiPlatform = document.getElementById('cqtaiPlatform');
    const veoModelSelect = document.getElementById('veoModelSelect');
    const nanoModelSelect = document.getElementById('nanoModelSelect');
    const veoOptions = document.getElementById('veoOptions');

    const updateCqtaiPlatform = () => {
        if (cqtaiPlatform.value === 'veo') {
            veoModelSelect.classList.remove('d-none');
            nanoModelSelect.classList.add('d-none');
            veoOptions.classList.remove('d-none');
        } else {
            veoModelSelect.classList.add('d-none');
            nanoModelSelect.classList.remove('d-none');
            veoOptions.classList.add('d-none');
        }
    };

    cqtaiPlatform.addEventListener('change', updateCqtaiPlatform);

    // 8. 文生图生成按钮
    document.getElementById('generateImageBtn').addEventListener('click', generateNanoImages);
    document.getElementById('clearImagesBtn').addEventListener('click', clearImageResults);
    document.getElementById('clearFailedImagesBtn').addEventListener('click', clearFailedImages);

    // 9. 图生图模式切换
    const textToImageMode = document.getElementById('textToImageMode');
    const imageToImageMode = document.getElementById('imageToImageMode');
    const imageUploadArea = document.getElementById('imageUploadArea');

    const updateImageGenMode = () => {
        console.log('切换图片生成模式...');
        if (imageToImageMode.checked) {
            console.log('切换到图生图模式');
            imageUploadArea.classList.remove('d-none');

            // 显示区域后延迟重新初始化拖拽功能
            setTimeout(() => {
                console.log('重新初始化拖拽上传区域');
                setupDragAndDrop();
            }, 100);
        } else {
            console.log('切换到文生图模式');
            imageUploadArea.classList.add('d-none');
        }
    };

    textToImageMode.addEventListener('change', updateImageGenMode);
    imageToImageMode.addEventListener('change', updateImageGenMode);

    // 10. 拖拽上传区域
    setupDragAndDrop();

    // 11. 图片上传文件选择
    const refImageUpload = document.getElementById('refImageUpload');
    refImageUpload.addEventListener('change', (e) => {
        handleFileUpload(e.target.files);
    });

    // 12. 页面加载完成后初始化已存在的卡片拖拽
    initializeExistingDraggableCards();
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

    // UI：换主题重新开始时，必须清理上一轮的"完成态/禁用态"
    resetSessionUIState();

    resetSteps();
    updateProgress(10, 'DeepSeek 正在进行全局策划与分镜拆解...', 1);

    try {
        const abortSignal = beginCancelableOp('策划生成');
        // 初始化全局状态
        globalScenes = [];
        globalConcept = null;
        globalSeriesAnchor = null;
        videoTasks = {};
        let currentSceneIndex = 0;
        
        // 只生成第一个分镜，后续分镜通过"生成下一个"按钮逐一生成
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

// 生成整体视频策划方案（全局大纲）- 已弃用，改为逐一生成模式
// 保留此函数仅为参考，实际不再使用
/*
async function generateGlobalConcept(apiKey, topic, sceneCount, sceneDuration, abortSignal) {
    // 生成整体策划方案的 System Prompt
    const systemPrompt = `你是一位获得奥斯卡奖的电影导演和创意策划专家。你的任务是为主题【${topic}】制定**整体视频策划方案**。

**你的使命：**
- 从整体视角出发，构思如何通过 ${sceneCount} 个分镜（每个 ${sceneDuration} 秒）来表达主题【${topic}】
- 制定整体的叙事节奏、情感曲线和视觉风格
- 为后续的分镜生成提供全局指导

**必须包含的内容（这是整体策划，不是单个镜头的描述）：**
1. **核心立意**：主题【${topic}】的深层内涵和核心表达
2. **整体叙事结构**：${sceneCount} 个分镜如何层层递进，讲述一个完整的故事
3. **情感曲线**：从开始到结束，观众情绪如何变化（例如：平静→紧张→震撼→升华）
4. **整体视觉风格**：贯穿整个视频的色彩、光影、镜头语言风格
5. **关键视觉符号**：2-3个重复出现的视觉元素，用于统一整个视频的主题表达

**输出格式要求：**
请以自然语言的段落形式输出策划方案，不要使用列表或JSON。内容要整体性、连贯性，让读者能够清晰看到整个视频的完整蓝图。`;

    // 调用 API 获取整体策划方案
    const userPrompt = `请为主题【${topic}】制定一个 ${sceneCount} 个分镜的整体视频策划方案。`;

    const result = await callDeepSeek(apiKey, systemPrompt, userPrompt, 2048, 60000, abortSignal);
    
    // 存储整体策划方案
    globalConcept = result.trim();
    
    if (!globalConcept) {
        throw new Error('整体策划方案生成失败');
    }

    // 生成系列共同锚点（确保所有分镜都记住这是同一个系列）
    await generateSeriesAnchor(apiKey, topic, sceneCount, abortSignal);
}
*/

// 生成系列共同锚点（系列视频的统一特征）- 已弃用，改为逐一生成模式
// 保留此函数仅为参考，实际不再使用
/*
async function generateSeriesAnchor(apiKey, topic, sceneCount, abortSignal) {
    const anchorSystemPrompt = `你是一位系列视频策划专家。你的任务是为主题【${topic}】制定**系列共同锚点**。

**什么是系列共同锚点？**
系列共同锚点是贯穿所有分镜的核心特征，确保：
1. 所有分镜都属于同一个系列（例如："十二星座"系列，每个分镜都必须体现"星座"这个核心）
2. 每个分镜都有自己的独特性，但都服务于整体主题
3. 观众一眼就能认出这是同一个系列的视频

**必须包含的内容：**
1. **核心系列特征**：什么是贯穿所有分镜的核心特征？（例如："每个分镜必须明确体现一个星座的特性"）
2. **系列统一元素**：哪些元素必须在每个分镜中都出现？（例如："星座符号"、"神兽形象"等）
3. **分镜差异化原则**：不同分镜如何区分？（例如："每个分镜对应一个不同的星座"）
4. **记忆点设计**：如何让观众记住这是一个系列？（例如："每个分镜结尾都展示对应的星座符号"）

**输出格式要求：**
请以简洁的段落形式输出，直接回答以上4个问题，不要有多余的废话。`;

    const anchorUserPrompt = `为主题【${topic}】制定系列共同锚点，确保 ${sceneCount} 个分镜都属于同一个系列。`;

    const anchorResult = await callDeepSeek(apiKey, anchorSystemPrompt, anchorUserPrompt, 1024, 60000, abortSignal);
    
    // 存储系列共同锚点
    globalSeriesAnchor = anchorResult.trim();
    
    if (!globalSeriesAnchor) {
        throw new Error('系列共同锚点生成失败');
    }
}
*/

// 生成下一个分镜（数据层函数 - 只负责向 globalScenes 追加一个新分镜，不做界面跳转/按钮状态修改）
async function generateNextSceneData(apiKey, topic, totalScenes, duration, index, abortSignal) {
    if (index >= totalScenes) return null;

    updateProgress(30 + (index * 70 / totalScenes), `正在生成第 ${index + 1} 个分镜...`, 1);

    // 参考已生成内容，保证风格一致与递进
    const existingScenes = globalScenes.slice(0, index);
    const existingSummaries = existingScenes.map(s => s.summary).filter(Boolean).join('\n- ');

    const systemPrompt = `你是一位精通AI视频生成的创意总监和分镜师，擅长从复杂主题中提炼核心创意。你的任务是根据主题构思具有高视觉冲击力和情感深度的视频大纲。

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
    * **背景细节必须爆炸丰富（硬指标）**：在 [环境/背景细节] 中必须构建多层次的空间感，融合前景、中景和远景元素，形成深度与层次。前景应包含细微的触手可及之物，如水珠悬挂、灰尘飘舞、叶影轻摇、雨滴滑落或反光闪烁的表面；中景需要表现场景的核心内容和视觉焦点，可以是建筑结构、人物形态、关键道具、装饰元素或重要符号；远景则应渲染环境的广阔感和氛围，如天际线轮廓、山脉起伏、极光流转或云层变幻。所有这些元素应当自然融合，共同构建出一个富有深度和细节的视觉世界。
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
            "summary": "必须使用结构化格式输出： [主体]... + [环境/背景细节(多层次空间感，融合前景细微元素、中景核心内容和远景环境氛围)]... + [关键动作/动态(≥2)]... + [运镜/镜头语言(含景深/焦点)]... + [光影/材质(≥4)]... + [主题锚点符号(≥2)]... + [情感暗示]... + [场景时间线(当涉及多个场景时必须明确时间线与场景切换)]...",
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

    // User Prompt：明确要求生成整体策划和分镜数据
    const userPrompt = `开始策划：请为主题【${topic}】制定整体策划方案，并生成第 ${index + 1} 个分镜的详细描述。

请按照 JSON 结构模版输出，必须包含 analysis（分析）、creative_strategy（创意策略）和 outline（分镜大纲）。`;

    // 调用 API
    const resultRaw = await callDeepSeek(apiKey, systemPrompt, userPrompt, 4096, 60000, abortSignal);
    const result = parseJsonResult(resultRaw);

    // 结果处理
    const outlineArr = Array.isArray(result.outline) ? result.outline : [];
    const picked =
        outlineArr.find(s => String(s.id) === String(index + 1)) ||
        outlineArr[0] ||
        null;

    if (!picked) {
        throw new Error('模型生成数据解析失败，请重试');
    }

    // 只在首次生成时写入全局策划（避免后续生成覆盖用户已编辑的策划内容）
    if (index === 0 && !globalConcept) {
        globalConcept = [result.analysis, result.creative_strategy].filter(Boolean).join('\n\n');
    }

    const newScene = {
        ...picked,
        video_prompt: null,
        voiceover: null,
        description: null,
        detail_generated: false,
        regen_hint: '',
        initial_frame_prompt: null,
        initial_frame_design: null,
        initial_frame_url: null,
        initial_frame_model: null,
        initial_frame_alternatives: []
    };

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
function updateInitialFramePrompt(index, value) { globalScenes[index].initial_frame_prompt = value; }

/**
 * 切换自定义控制面板
 */
function toggleCustomControls(index) {
    const controls = document.getElementById(`custom-frame-controls-${index}`);
    if (controls) {
        controls.classList.toggle('d-none');
    }
}

/**
 * 选择备选图片作为主图
 */
function selectAlternativeImage(index, altIndex) {
    const scene = globalScenes[index];
    if (!scene.initial_frame_alternatives || altIndex >= scene.initial_frame_alternatives.length) {
        return;
    }

    // 交换主图和备选图
    const mainUrl = scene.initial_frame_url;
    const altUrl = scene.initial_frame_alternatives[altIndex];

    scene.initial_frame_url = altUrl;
    scene.initial_frame_alternatives[altIndex] = mainUrl;

    // 更新UI
    renderSceneDetail(index);

    // 显示提示
    const toast = document.createElement('div');
    toast.className = 'alert alert-info alert-dismissible fade show position-fixed';
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
    toast.innerHTML = `
        <i class="bi bi-images"></i> 已切换图片
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

/**
 * 删除备选图片
 */
function removeAlternativeImage(index, altIndex) {
    const scene = globalScenes[index];
    if (!scene.initial_frame_alternatives || altIndex >= scene.initial_frame_alternatives.length) {
        return;
    }

    // 删除指定的备选图
    scene.initial_frame_alternatives.splice(altIndex, 1);

    // 更新UI
    renderSceneDetail(index);

    // 显示提示
    const toast = document.createElement('div');
    toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
    toast.innerHTML = `
        <i class="bi bi-trash"></i> 已删除备选图
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

/**
 * 自动生成初始画面（使用默认模型，不显示提示词）
 */
async function autoGenerateInitialFrame(index) {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) {
        alert('请先输入 DeepSeek API Key');
        return;
    }

    const scene = globalScenes[index];
    const detailArea = document.getElementById(`scene-detail-area-${index}`);
    const initialFrameCard = detailArea.querySelector('.card.border-primary');
    const cardBody = initialFrameCard?.querySelector('.card-body');

    if (!cardBody) {
        console.error('找不到初始画面卡片');
        return;
    }

    // 显示加载状态
    cardBody.innerHTML = `
        <div class="text-center py-3">
            <div class="spinner-border text-primary mb-2"></div>
            <p class="text-muted small mb-0">正在生成初始画面...</p>
            <small class="text-muted">系统将自动生成提示词并使用默认模型</small>
        </div>
    `;

    try {
        const abortSignal = beginCancelableOp(`生成初始画面 #${index + 1}`);

        // 步骤1：生成提示词（自动）
        const promptResult = await generateInitialFramePrompt(index, abortSignal);

        // 步骤2：直接调用图片生成（使用默认模型 nano-banana-pro）
        const imageResult = await generateInitialFrameImage(
            index,
            promptResult.prompt,
            'nano-banana-pro', // 默认使用 nano-banana-pro 模型
            abortSignal
        );

        // 更新数据
        globalScenes[index].initial_frame_design = promptResult.design_logic;
        globalScenes[index].initial_frame_prompt = promptResult.prompt;
        globalScenes[index].initial_frame_url = imageResult.url;
        globalScenes[index].initial_frame_model = 'nano-banana-pro';

        console.log('初始画面生成成功:', {
            url: imageResult.url,
            model: 'nano-banana-pro',
            design_logic: promptResult.design_logic
        });

        // 更新UI
        renderSceneDetail(index);

        // 显示成功提示
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
        toast.innerHTML = `
            <i class="bi bi-check-circle"></i> 初始画面已生成
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);

    } catch (error) {
        console.error('生成初始画面失败:', error);
        cardBody.innerHTML = `
            <div class="alert alert-danger mb-0">
                <i class="bi bi-exclamation-triangle"></i> 生成失败: ${escapeHtml(error.message)}
                <button class="btn btn-sm btn-danger mt-2" onclick="autoGenerateInitialFrame(${index})">
                    <i class="bi bi-arrow-counterclockwise"></i> 重试
                </button>
            </div>
        `;
    } finally {
        endCancelableOp();
    }
}

/**
 * 自定义生成初始画面（使用用户修改的提示词和选择的模型）
 */
async function customGenerateInitialFrame(index) {
    const prompt = document.getElementById(`initial-frame-prompt-${index}`).value.trim();
    const model = document.getElementById(`initial-frame-model-${index}`).value;
    const count = parseInt(document.getElementById(`initial-frame-count-${index}`).value);

    if (!prompt) {
        alert('请输入提示词');
        return;
    }

    const cqtaiKey = document.getElementById('veoApiKey').value.trim();
    if (!cqtaiKey) {
        alert('请输入 CQTAI API Key');
        return;
    }

    const scene = globalScenes[index];
    const detailArea = document.getElementById(`scene-detail-area-${index}`);
    const initialFrameCard = detailArea.querySelector('.card.border-primary');
    const cardBody = initialFrameCard?.querySelector('.card-body');

    // 显示加载状态
    cardBody.innerHTML = `
        <div class="text-center py-3">
            <div class="spinner-border text-primary mb-2"></div>
            <p class="text-muted small mb-0">正在生成${count}张候选图...</p>
            <small class="text-muted">使用模型: ${model}</small>
        </div>
    `;

    try {
        const abortSignal = beginCancelableOp(`自定义生成初始画面 #${index + 1}`);

        // 并发生成多张图片
        const promises = [];
        for (let i = 0; i < count; i++) {
            promises.push(generateInitialFrameImage(index, prompt, model, abortSignal));
        }

        const results = await Promise.all(promises);

        // 更新数据（使用第一张作为主图，其他作为备选）
        globalScenes[index].initial_frame_prompt = prompt;
        globalScenes[index].initial_frame_url = results[0].url;
        globalScenes[index].initial_frame_model = model;

        if (results.length > 1) {
            globalScenes[index].initial_frame_alternatives = results.slice(1).map(r => r.url);
        }

        // 更新UI
        renderSceneDetail(index);

        // 显示成功提示
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
        toast.innerHTML = `
            <i class="bi bi-check-circle"></i> 已生成${count}张候选图
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);

    } catch (error) {
        console.error('自定义生成失败:', error);
        cardBody.innerHTML = `
            <div class="alert alert-danger mb-0">
                <i class="bi bi-exclamation-triangle"></i> 生成失败: ${escapeHtml(error.message)}
                <button class="btn btn-sm btn-danger mt-2" onclick="customGenerateInitialFrame(${index})">
                    <i class="bi bi-arrow-counterclockwise"></i> 重试
                </button>
            </div>
        `;
    } finally {
        endCancelableOp();
    }
}

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

            <!-- 图片上传区（用于图生视频模式） -->
            <div class="mt-2 p-2 bg-light rounded">
                <label class="form-label small mb-1">参考图片（可选，图生视频模式使用）</label>
                <div class="mb-2">
                    <input type="file" class="form-control form-control-sm" id="veoImageUpload-${index}" accept="image/*" multiple onchange="handleImageUpload(${index})">
                    <small class="text-muted">注意：仅用于预览，Veo API需要公开的图片URL</small>
                </div>
                <!-- 图片预览区 -->
                <div id="image-preview-${index}" class="d-flex gap-2 flex-wrap mb-2"></div>
                <!-- URL输入区（必须使用公开URL） -->
                <div class="alert alert-warning mb-2" role="alert" style="padding: 0.5rem 0.75rem;">
                    <i class="bi bi-exclamation-triangle"></i> 
                    <strong>重要：</strong>Veo API 需要公开的图片URL，不支持Base64格式。<br>
                    <small>如果您上传了本地图片，请先将其上传到图床（如 <a href="https://imgur.com" target="_blank">Imgur</a>、<a href="https://imgbox.com" target="_blank">ImgBox</a>），然后将获得的URL粘贴到下方。</small>
                </div>
                <!-- URL输入区 -->
                <textarea class="form-control form-control-sm" id="veoImageUrls-${index}" rows="2" placeholder="输入公开的图片URL，每行一个&#10;例如：&#10;https://i.imgur.com/abc123.jpg&#10;https://i.imgur.com/def456.jpg"></textarea>
                <small class="text-muted">图生视频模式：使用第一张图片；首尾帧模式：使用前两张图片</small>
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
 * 生成初始画面的提示词（用于图生视频）
 */
async function generateInitialFramePrompt(index, abortSignal) {
    const apiKey = document.getElementById('apiKey').value.trim();
    const scene = globalScenes[index];
    const topic = document.getElementById('topic').value.trim();
    const globalConceptStr = (typeof globalConcept === 'string' ? globalConcept : document.getElementById('globalConcept')?.value || '').trim();

    if (!apiKey) { throw new Error('请先输入 DeepSeek API Key'); }

    const systemPrompt = `你是一位资深的电影视觉导演和 AI 绘画提示词专家，精通 Midjourney、DALL-E 3、Flux 等 AI 绘画模型。

**任务描述：**
我会为你提供一段视频的"分镜演变内容"（从 A 状态到 B 状态的过程）。请你基于这段描述，为我设计最关键的**"初始画面（Initial Frame）"**。

**设计原则：**
1. **捕捉起始瞬间**：初始画面应该展现视频的第一帧，让观众一眼就能理解场景的开始状态
2. **视觉张力**：虽然只是静态画面，但要暗示后续的动态变化（如：雨滴悬空暗示下落、火焰初燃暗示蔓延）
3. **与分镜风格一致**：必须严格遵循分镜的视觉风格指南（风格、色调、镜头语言）
4. **突出主体**：初始画面要清晰地展示主体，不要让过多的元素分散注意力
5. **预留发展空间**：画面布局要为后续的动态变化留出空间（如：左侧留白给物体进入，上方留白给镜头上升）

**输出要求：**
请将初始画面转化为极其详细的 AI 绘画提示词。你的描述需要包含以下维度：

1. **主体细节**：外貌、材质、服饰、神态
2. **构图与镜头**：镜头焦距（如 35mm）、构图方式（如特写、黄金分割）、视角（如低仰角）
3. **光影与色彩**：光源方向、色调（如电影级青橙色调）、氛围感
4. **环境背景**：具体的空间背景、天气、氛围元素（如烟雾、微尘）
5. **风格化参数**：画质要求（如 Photorealistic, 8k, Unreal Engine 5 render）

**输出格式（JSON）：**
{
    "design_logic": "画面设计逻辑：简述为什么要这样设计第一帧以配合后续视频演变（100-200字）",
    "prompt": "英文提示词 (Prompt)：直接可用于 Midjourney/DALL-E 3/Flux 的完整提示词，长度 80-150 words",
}`;

    const userPrompt = `**主题：**${topic}

**整体艺术基调：**${globalConceptStr}

**分镜信息：**
- 分镜简述：${scene.summary}
- 视觉风格：${scene.style_guide}
- 时长：${scene.duration}秒

**任务：**
请基于以上分镜信息，设计这个分镜的初始画面（第一帧），并生成详细的 AI 绘画提示词。`;

    const resultRaw = await callDeepSeek(apiKey, systemPrompt, userPrompt, 2048, 120000, abortSignal);
    const result = parseJsonResult(resultRaw);

    return result;
}

/**
 * 使用Nano API生成初始画面
 */
async function generateInitialFrameImage(index, prompt, model, abortSignal) {
    const cqtaiKey = document.getElementById('veoApiKey').value.trim();
    if (!cqtaiKey) {
        throw new Error('请输入 CQTAI API Key');
    }

    const url = NANO_BASE_URL;

    // 获取视频比例设置
    const videoRatio = (document.getElementById('videoRatio')?.value || '9:16').trim();

    // 根据比例设置分辨率
    let resolution = '1024x1792'; // 默认 9:16
    if (videoRatio === '16:9') {
        resolution = '1920x1080';
    } else if (videoRatio === '1:1') {
        resolution = '1024x1024';
    } else if (videoRatio === '3:4' || videoRatio === '4:3') {
        resolution = '1536x2048';
    }

    // 构建请求体
    const requestBody = {
        model: model,
        prompt: prompt,
        aspectRatio: videoRatio, // 使用视频比例
        resolution: resolution,
        numImages: 1
    };

    console.log(`初始画面生成请求 (分镜 ${index}):`, JSON.stringify(requestBody, null, 2));

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cqtaiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error("Nano API错误:", errText);
        throw new Error(`Nano API错误 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log(`Nano响应 (分镜 ${index}):`, JSON.stringify(data, null, 2));

    if (data.code === 200 && data.data) {
        const taskId = data.data;
        return pollInitialFrameResult(cqtaiKey, taskId, index, abortSignal);
    }

    throw new Error("Nano返回数据格式无法解析: " + JSON.stringify(data));
}

/**
 * 轮询初始画面生成结果
 */
async function pollInitialFrameResult(apiKey, taskId, index, abortSignal) {
    let retryCount = 0;

    return await new Promise((resolve, reject) => {
        const intervalId = setInterval(async () => {
            try {
                if (abortSignal && abortSignal.aborted) {
                    clearInterval(intervalId);
                    reject(new Error('已中断'));
                    return;
                }

                if (retryCount >= 200) { // 约 10分钟超时
                    clearInterval(intervalId);
                    reject(new Error('生成超时'));
                    return;
                }

                const queryUrl = `${NANO_INFO_URL}?id=${taskId}`;
                const res = await fetch(queryUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/json'
                    }
                });

                if (!res.ok) {
                    console.error("查询响应错误:", res.status);
                    return;
                }

                const data = await res.json();

                if (data.code === 200 && data.data) {
                    const task = data.data;

                    if (task.status === 'succeeded' || task.status === 'completed') {
                        clearInterval(intervalId);
                        const imageUrl = task.resultUrl || task.url || null;
                        resolve({ status: 'SUCCESS', url: imageUrl });
                    } else if (task.status === 'failed' || task.status === 'error') {
                        clearInterval(intervalId);
                        const errorMsg = task.errorMsg || data.msg || "生成失败";
                        reject(new Error(errorMsg));
                    }
                }

                retryCount++;
            } catch (e) {
                console.error("轮询初始画面结果时出错:", e);
            }
        }, 3000);
    });
}

/**
 * 生成单个分镜的详细脚本 (基于"高保真渲染框架"优化版)
 */
async function generateSingleSceneDetail(index, externalAbortSignal) {
    const apiKey = document.getElementById('apiKey').value.trim();
    const scene = globalScenes[index];
    const detailArea = document.getElementById(`scene-detail-area-${index}`);
    const topic = document.getElementById('topic').value.trim();
    // 确保获取到整体基调字符串
    const globalConceptStr = (typeof globalConcept === 'string' ? globalConcept : document.getElementById('globalConcept')?.value || '').trim();
    const detailPreset = (document.getElementById('detailPreset')?.value || 'standard').trim();
    const narrationMode = (document.getElementById('narrationMode')?.value || 'on').trim();
    const videoRatio = (document.getElementById('videoRatio')?.value || '9:16').trim();

    // 1. 动态时间轴规划 (保持不变，这是非常好的逻辑)
    const segments = (() => {
        const d = Number(scene.duration || 5);
        if (d >= 20) return ['0s-6s', '6s-12s', '12s-20s'];
        if (d >= 15) return ['0s-5s', '5s-10s', '10s-15s'];
        if (d >= 12) return ['0s-4s', '4s-8s', '8s-12s'];
        if (d >= 10) return ['0s-3s', '3s-7s', '7s-10s'];
        if (d >= 8)  return ['0s-2s', '2s-5s', '5s-8s'];
        if (d >= 6)  return ['0s-2s', '2s-4s', '4s-6s'];
        return ['0s-2s', '2s-4s', '4s-5s']; // 5秒默认三段式
    })();

    // UI Loading
    detailArea.innerHTML = `<div class="text-center text-muted small"><span class="spinner-border spinner-border-sm"></span> 正在进行微观纹理渲染...</div>`;

    try {
        // 使用独立的可中断控制器，避免与其他操作冲突
        let abortSignal = externalAbortSignal;
        if (!abortSignal) {
            const controller = beginCancelableOp(`生成分镜${index + 1}详细脚本`);
            abortSignal = controller.signal || controller;
        }
        
        // 1. 动态时间轴规划 (保持不变，这是非常好的逻辑)
        const segments = (() => {
            const d = Number(scene.duration || 5);
            if (d >= 20) return ['0s-6s', '6s-12s', '12s-20s'];
            if (d >= 15) return ['0s-5s', '5s-10s', '10s-15s'];
            if (d >= 12) return ['0s-4s', '4s-8s', '8s-12s'];
            if (d >= 10) return ['0s-3s', '3s-7s', '7s-10s'];
            if (d >= 8)  return ['0s-2s', '2s-5s', '5s-8s'];
            if (d >= 6)  return ['0s-2s', '2s-4s', '4s-6s'];
            return ['0s-2s', '2s-4s', '4s-5s']; // 5秒默认三段式
        })();

        // ============================================================
        // 核心优化：System Prompt - 定义“高保真渲染专家”人格
        // ============================================================
        const systemPrompt = `你是一位世界级的数字艺术家和电影摄影指导(DOP)，精通CogVideoX与Sora模型的提示词工程。

**你的核心工作流：**
你不仅仅是在写描述，你是在脑海中运行一个**"物理渲染引擎"**。你需要将用户提供的简略分镜，转化为包含光线追踪、材质物理属性、流体动力学和摄影机参数的**"可执行渲染脚本"**。

**高保真渲染标准 (High-Fidelity Standard)：**
1. **叙事流体化 (Narrative Fluidity)**：将画面描述为连续的时间流（Time-Flow），而非静态的快照。关注物体是如何进入画面、如何移动、以及如何离开焦点的。
2. **空间层次感 (Spatial Hierarchy)**：强制使用全景(wide shot)或远景(establishing shot)，展示完整的场景和空间关系。采用第三方视角，让观众以观察者的身份观看，增强沉浸感和真实感。严禁使用特写镜头，保持适度的观察距离。
3. **氛围营造 (Atmosphere Building)**：强调环境光效、色彩情绪和空间感，让观众沉浸在场景的氛围中，而非仅仅关注物体表面。

**输入上下文：**
主题：${topic}
整体艺术基调：${globalConceptStr}`;

        // 读取用户的额外要求
        const extra = (globalScenes[index].regen_hint || '').trim();

        // ============================================================
        // 核心优化：Pro 模式 - 结构化引导模板 (Format Guide)
        // ============================================================
        // 这里不使用“禁止”，而是给出“最佳实践模板”
        const proRules = detailPreset === 'pro' ? `
【专业级提示词构建指南 (Pro Mode Blueprint)】

请按照以下 **"空间层次结构"** 来构建每个时间段（${segments.join(' / ')}）的描述：

**Layer 1: 空间构图 (Spatial Composition)**
* 强制使用全景(wide shot)或远景(establishing shot)，展示完整的场景和空间关系。
* 采用第三方视角，让观众以观察者的身份观看场景，避免主观第一人称视角。
* 优先考虑环绕式运镜：orbits, pans, crane movements，严禁推近(push in)和特写镜头。
* *Guidance:* 使用 "sweeping pan", "slow orbit", "crane down", "aerial view" 等动态运镜词汇，展示整体空间和场景规模。

**Layer 2: 环境氛围 (Environmental Atmosphere)**
* 定义整体环境：光影分布、色彩情绪、天气条件。
* 强调空间感：深度、透视、层次，让观众感受到场景的规模。
* *Guidance:* 描述环境光效（如 "volumetric fog", "ambient light", "atmospheric haze"）和整体色调。

**Layer 3: 细节平衡 (Detail Balance)**
* **适度细节**：包含必要细节，但保持适度的观察距离，不过度聚焦微观细节。
* **重点在于氛围**：细节应服务于整体氛围，而非独立展示。
* **材质与互动**：描述材质特性及其在环境中的反应，如光线反射、风吹效果。
* *Guidance:* 确保画面保持全景视角，所有细节都在整体场景中呈现，避免特写和局部放大。

**Technical Specification (技术参数)**
* 在Prompt末尾统一添加渲染参数：画幅 ${videoRatio}, cinematic lens, dynamic movement, atmospheric lighting, 8k, photorealistic.
` : '';

        const narrationRule = narrationMode === 'off'
            ? 'Voiceover Strategy: Return an empty string "", but ensure ambient sound design is described in the prompt.'
            : `Voiceover Strategy: Generate Chinese voiceover scripts that are conversational, emotive, and strictly synchronized with the visual pacing.`;

        const userPrompt = `
**渲染任务：**
请基于以下分镜设计，生成高精度的英文Video Prompt和中文执行脚本。

**分镜参数：**
- 原始构思：${scene.summary}
- 视觉风格：${scene.style_guide}
- 时长：${scene.duration}s

${narrationRule}

${proRules}

${extra ? `**用户特别修正指令 (User Overrides):** ${extra}` : ''}

**输出格式要求 (JSON Structure)：**

{
    "description": "中文执行脚本。请用优美的'导演语言'编写，侧重于光影氛围、镜头调度和声音设计的描述，供后期团队参考。",
    
    "video_prompt": "符合CogVideoX/Sora标准的英文提示词。要求：\n1. **Structure (结构)**: 严格按照时间轴 ${segments.join(' / ')} 进行分段描述。\n2. **Content (内容)**: 必须包含 'Layer 1/2/3' 的所有细节（动态、光影、微观纹理）。\n3. **Style (文风)**: 使用 'Narrative Prose' (散文体)，流畅连接各个视觉元素，避免机械列表。\n4. **Vocabulary (词汇)**: 积极使用推荐词汇 (e.g., iridescent, subsurface scattering, chromatic aberration, particulate matter)。\n5. **Fidelity (保真度)**: 能够被视频模型精准理解，纯英文，无Markdown标记，长度 > 160 words。",
    
    "voiceover": "中文旁白内容。"
}`;

        const maxTokens = detailPreset === 'pro' ? 4096 : 2048;
        const timeoutMs = detailPreset === 'pro' ? 300000 : 120000;

        // 调用 DeepSeek
        const resultRaw = await callDeepSeek(apiKey, systemPrompt, userPrompt, maxTokens, timeoutMs * 2, abortSignal);
        const result = parseJsonResult(resultRaw);

        // ============================================================
        // 核心优化：智能增强逻辑 (Enhancement Logic)
        // ============================================================
        // 这里的逻辑不是"修复错误"，而是"增强细节"。
        // 如果生成的 Prompt 不够丰富，我们请求 AI 进行"上色 (Upscaling)"
        const needEnhancement = (() => {
            if (detailPreset !== 'pro') return false;
            const vp = String(result.video_prompt || '');
            const words = countEnglishWords(vp);

            // 检查标准：是否过短？是否缺少时间轴？是否缺少空间感？
            const hasTimeline = /\d+s\s*[-–to]\s*\d+s/i.test(vp);
            const qualityKeywords = /texture|refraction|shadow|volumetric|dust|particle|lens/i;
            const hasQuality = qualityKeywords.test(vp);

            // 检查是否有任何特写镜头（严格禁止）
            const anyCloseUp = /close[- ]up|macro lens|microscopic|zoom in|push in|detail shot|extreme shot/i.test(vp);
            // 检查是否有全景或远景描述（必须包含）
            const hasWideOrEstablishing = /wide shot|establishing shot|panoramic|aerial view|long shot|full scene/i.test(vp);

            return words < 160 || !hasTimeline || !hasQuality || anyCloseUp || !hasWideOrEstablishing;
        })();

        if (needEnhancement) {
            const enhanceSystem = `你是一位Prompt润色专家。你的任务是提升这段Prompt的画面精度和文学性。
            
**优化目标：**
1. **Spatial Balance (空间平衡)**：平衡全景、中景和特写，优先展示整体环境和氛围。
2. **Atmospheric Focus (氛围重点)**：强调环境光效、色彩情绪和空间感，让观众沉浸在场景中。
3. **Movement Fluidity (运动流畅性)**：使用环绕、平移等运镜，而非过度推近。`;

            const enhanceUser = `
请将以下 Video Prompt 扩写并润色，使其达到电影级渲染标准。

**原 Prompt：**
${result.video_prompt}

**扩写要求：**
1. 保持原有的时间轴结构。
2. 增强空间感和氛围：强制使用全景(wide shot)或远景(establishing shot)，严禁使用特写镜头。
3. 采用第三方视角，让观众以观察者的身份观看场景，保持适度的观察距离。
4. 加入环境光效和整体色调描述，增强氛围感。
5. 确保运镜流畅，使用环绕、平移、鸟瞰(aerial view)等运镜方式，严禁推近(push in)和特写。
6. 仅输出 JSON: { "video_prompt": "..." }
`.trim();

            const enhancedRaw = await callDeepSeek(apiKey, enhanceSystem, enhanceUser, 2048, 60000, abortSignal);
            const enhanced = parseJsonResult(enhancedRaw);
            if (enhanced && enhanced.video_prompt) {
                result.video_prompt = enhanced.video_prompt;
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

    // 检查是否已有初始画面
    const hasInitialFrame = scene.initial_frame_url && scene.initial_frame_prompt;

    detailArea.innerHTML = `
        <div class="row">
            <!-- 初始画面生成区域 -->
            <div class="col-md-12 mb-3">
                <div class="card border-primary" style="border-width: 2px;">
                    <div class="card-header bg-primary text-white py-2 px-3 d-flex justify-content-between align-items-center">
                        <div>
                            <i class="bi bi-image"></i> 初始画面生成（用于图生视频）
                            <small class="text-white-50 ms-2">第一帧设计</small>
                        </div>
                        ${!hasInitialFrame ? `
                            <button class="btn btn-sm btn-light" onclick="autoGenerateInitialFrame(${index})">
                                <i class="bi bi-magic"></i> 生成初始画面
                            </button>
                        ` : `
                            <button class="btn btn-sm btn-outline-light" onclick="autoGenerateInitialFrame(${index})">
                                <i class="bi bi-arrow-clockwise"></i> 重新生成
                            </button>
                        `}
                    </div>
                    <div class="card-body">
                        ${!hasInitialFrame ? `
                            <div class="text-center text-muted py-3">
                                <i class="bi bi-image display-6 mb-2"></i>
                                <p class="mb-0">点击上方按钮自动生成初始画面</p>
                                <small>系统将自动生成提示词并使用默认模型生成图片<br>如不满意可手动调整</small>
                            </div>
                        ` : `
                            <!-- 已生成初始画面显示区 -->
                            <div class="mb-3">
                                <div class="d-flex gap-3">
                                    <div class="flex-grow-1">
                                        <div class="position-relative">
                                            <img src="${scene.initial_frame_url}" alt="初始画面"
                                                 class="img-fluid rounded border clickable-image"
                                                 style="max-height: 400px; width: auto; cursor: pointer; transition: transform 0.2s;"
                                                 onclick="window.open('${escapeHtml(scene.initial_frame_url)}', '_blank')"
                                                 onmouseover="this.style.transform='scale(1.02)'"
                                                 onmouseout="this.style.transform='scale(1)'">
                                            <span class="position-absolute top-0 start-0 badge bg-success m-2">
                                                <i class="bi bi-check-circle"></i> 主图
                                            </span>
                                            <!-- 悬浮操作按钮 -->
                                            <div class="position-absolute top-0 end-0 m-2 d-flex flex-column gap-1"
                                                 style="z-index: 10;">
                                                <button class="btn btn-sm btn-light border shadow-sm"
                                                        onclick="event.stopPropagation(); window.open('${escapeHtml(scene.initial_frame_url)}', '_blank')"
                                                        title="在新窗口查看大图">
                                                    <i class="bi bi-box-arrow-up-right"></i>
                                                </button>
                                                <button class="btn btn-sm btn-success border shadow-sm"
                                                        onclick="event.stopPropagation(); downloadImage('${escapeHtml(scene.initial_frame_url)}', 'initial_frame_${index}.png')"
                                                        title="下载图片">
                                                    <i class="bi bi-download"></i>
                                                </button>
                                            </div>
                                        </div>

                                        <!-- 图片URL显示区 -->
                                        <div class="mt-2 p-2 bg-light border rounded">
                                            <label class="form-label small fw-bold mb-1">
                                                <i class="bi bi-link-45deg"></i> 图片URL（可复制用于图生视频）
                                            </label>
                                            <div class="input-group input-group-sm">
                                                <input type="text" class="form-control form-control-sm font-monospace"
                                                       id="initial-frame-url-${index}"
                                                       value="${escapeHtml(scene.initial_frame_url)}"
                                                       readonly
                                                       onclick="this.select()"
                                                       style="font-size: 0.85rem;">
                                                <button class="btn btn-sm btn-primary" onclick="copyToClipboard('${escapeHtml(scene.initial_frame_url)}'); document.getElementById('initial-frame-url-${index}').select();">
                                                    <i class="bi bi-clipboard"></i>
                                                </button>
                                                <button class="btn btn-sm btn-outline-secondary" onclick="window.open('${escapeHtml(scene.initial_frame_url)}', '_blank')">
                                                    <i class="bi bi-box-arrow-up-right"></i>
                                                </button>
                                            </div>
                                            <small class="text-muted mt-1 d-block">
                                                <i class="bi bi-info-circle"></i> 点击输入框可全选URL，复制后粘贴到下方"图生视频"的参考图片URL输入框
                                            </small>
                                        </div>

                                        ${scene.initial_frame_alternatives && scene.initial_frame_alternatives.length > 0 ? `
                                            <div class="mt-2">
                                                <small class="text-muted">备选图片：</small>
                                                <div class="d-flex gap-2 mt-1">
                                                    ${scene.initial_frame_alternatives.map((altUrl, idx) => `
                                                        <div class="position-relative">
                                                            <img src="${altUrl}" alt="备选${idx + 1}" class="rounded border" style="width: 80px; height: 80px; object-fit: cover; cursor: pointer;" onclick="selectAlternativeImage(${index}, ${idx})">
                                                            <button class="btn btn-sm btn-danger position-absolute top-0 end-0 m-1" style="width: 20px; height: 20px; padding: 0; border-radius: 50%;" onclick="event.stopPropagation(); removeAlternativeImage(${index}, ${idx})">×</button>
                                                        </div>
                                                    `).join('')}
                                                </div>
                                                <small class="text-muted small">点击图片可切换为主图</small>
                                            </div>
                                        ` : ''}
                                    </div>
                                    <div class="flex-grow-1">
                                        <label class="form-label small fw-bold text-primary"><i class="bi bi-lightbulb"></i> 设计逻辑</label>
                                        <div class="p-2 bg-light border rounded small" style="max-height: 250px; overflow-y: auto;">
                                            ${formatTextToHtml(scene.initial_frame_design)}
                                        </div>
                                        <div class="mt-2">
                                            <small class="text-muted">使用模型：</small>
                                            <span class="badge bg-secondary">${scene.initial_frame_model || 'nano-banana-pro'}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- 自定义控制区（默认折叠） -->
                            <div id="custom-frame-controls-${index}" class="d-none mt-3 p-3 bg-light border rounded">
                                <h6 class="mb-3"><i class="bi bi-sliders"></i> 自定义调整</h6>

                                <div class="mb-2">
                                    <label class="form-label small fw-bold"><i class="bi bi-brush"></i> AI绘画提示词（初始画面）</label>
                                    <div class="prompt-box">
                                        <textarea class="form-control form-control-sm" rows="4" id="initial-frame-prompt-${index}" onblur="updateInitialFramePrompt(${index}, this.value)">${escapeHtml(scene.initial_frame_prompt)}</textarea>
                                        <button class="btn btn-sm btn-light border copy-btn" onclick="copyToClipboard(document.getElementById('initial-frame-prompt-${index}').value)">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </div>
                                </div>

                                <div class="mb-2">
                                    <label class="form-label small fw-bold">选择模型</label>
                                    <select class="form-select form-select-sm" id="initial-frame-model-${index}">
                                        <option value="nano-banana-pro" selected ${scene.initial_frame_model === 'nano-banana-pro' ? 'selected' : ''}>nano-banana-pro（高画质，推荐）</option>
                                        <option value="nano-banana" ${scene.initial_frame_model === 'nano-banana' ? 'selected' : ''}>nano-banana（标准画质，速度更快）</option>
                                    </select>
                                </div>

                                <div class="mb-2">
                                    <label class="form-label small fw-bold">生成数量</label>
                                    <select class="form-select form-select-sm" id="initial-frame-count-${index}">
                                        <option value="1">生成 1 张候选图</option>
                                        <option value="2">生成 2 张候选图</option>
                                    </select>
                                </div>

                                <button class="btn btn-primary btn-sm w-100" onclick="customGenerateInitialFrame(${index})">
                                    <i class="bi bi-magic"></i> 按自定义设置重新生成
                                </button>
                            </div>

                            <!-- 自定义按钮 -->
                            <div class="text-center mt-2">
                                <button class="btn btn-sm btn-outline-primary" onclick="toggleCustomControls(${index})">
                                    <i class="bi bi-pencil"></i> 自定义调整
                                </button>
                            </div>
                        `}
                    </div>
                </div>
            </div>

            <!-- 详细描述 -->
            <div class="col-md-12 mb-2">
                <small class="text-muted">详细描述：</small> ${formatTextToHtml(scene.description || '')}
            </div>
            <div class="col-md-12 mb-2">
                 <small class="text-muted">旁白：</small> <span class="fst-italic text-secondary">"${escapeHtml(scene.voiceover || '')}"</span>
            </div>
            <div class="col-md-12">
                <div class="prompt-box">
                    <span class="badge bg-dark mb-1">视频提示词 (VIDEO PROMPT)</span>
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

    // 显示视频生成区域并添加图片上传框
    videoArea.classList.remove('d-none');
    // 检查是否已经有图片上传框，如果没有则添加
    if (!document.getElementById(`veoImageUpload-${index}`)) {
        const imageInputArea = document.createElement('div');
        imageInputArea.className = 'mt-2 p-2 bg-light rounded';
        imageInputArea.innerHTML = `
            <label class="form-label small mb-1">参考图片（可选，图生视频模式使用）</label>
            <div class="mb-2">
                <input type="file" class="form-control form-control-sm" id="veoImageUpload-${index}" accept="image/*" multiple onchange="handleImageUpload(${index})">
                <small class="text-muted">注意：仅用于预览，Veo API需要公开的图片URL</small>
            </div>
            <!-- 图片预览区 -->
            <div id="image-preview-${index}" class="d-flex gap-2 flex-wrap mb-2"></div>
            <!-- URL输入区（必须使用公开URL） -->
            <div class="alert alert-warning mb-2" role="alert" style="padding: 0.5rem 0.75rem;">
                <i class="bi bi-exclamation-triangle"></i> 
                <strong>重要：</strong>Veo API 需要公开的图片URL，不支持Base64格式。<br>
                <small>如果您上传了本地图片，请先将其上传到图床（如 <a href="https://imgur.com" target="_blank">Imgur</a>、<a href="https://imgbb.com" target="_blank">ImgBB</a>），然后将获得的URL粘贴到下方。</small>
            </div>
            <!-- URL输入区 -->
            <textarea class="form-control form-control-sm" id="veoImageUrls-${index}" rows="2" placeholder="输入公开的图片URL，每行一个&#10;例如：&#10;https://i.imgur.com/abc123.jpg&#10;https://i.imgur.com/def456.jpg"></textarea>
            <small class="text-muted">图生视频模式：使用第一张图片；首尾帧模式：使用前两张图片</small>
        `;
        // 插入到视频内容区域之前
        const videoContent = document.getElementById(`video-content-${index}`);
        videoArea.insertBefore(imageInputArea, videoContent);
    }
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
    const zhipuPlatform = document.getElementById('zhipuPlatform');
    const veoPlatform = document.getElementById('veoPlatform');

    // 判断使用哪个平台
    if (zhipuPlatform.checked) {
        return await generateZhipuVideo(index);
    } else if (veoPlatform.checked) {
        return await generateVeoVideo(index);
    }
}

// 智谱AI视频生成
async function generateZhipuVideo(index) {
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

        // 返回一个"完成Promise"，方便批量模式做真正的并发控制
        return pollVideoResult(token, taskId, index);

    } catch (e) {
        console.error(e);
        const statusBadge = document.getElementById(`video-status-${index}`);
        const contentDiv = document.getElementById(`video-content-${index}`);
        const btn = document.querySelector(`#video-result-area-${index} button`);
        statusBadge.className = 'badge bg-danger';
        statusBadge.innerText = '失败';
        btn.disabled = false;
        btn.innerHTML = '重试';
        contentDiv.innerHTML = `<span class="text-danger small">${e.message}</span>`;
    }
}

// Veo视频生成
async function generateVeoVideo(index) {
    const veoKey = document.getElementById('veoApiKey').value.trim();
    if (!veoKey) { alert('请输入 CQTAI API Key'); return; }

    const scene = globalScenes[index];
    if (!scene.detail_generated) { alert('请先生成分镜脚本！'); return; }

    const statusBadge = document.getElementById(`video-status-${index}`);
    const contentDiv = document.getElementById(`video-content-${index}`);
    const btn = document.querySelector(`#video-result-area-${index} button`);
    const veoModel = document.getElementById('veoModel').value;
    const veoMode = document.getElementById('veoMode').value;
    const veoExtendImg = document.getElementById('veoExtendImg').checked;
    const veoTranslate = document.getElementById('veoTranslate').checked;
    const videoRatio = (document.getElementById('videoRatio')?.value || '9:16').trim();

    // 获取上传的图片URL
    const imageUrlsInput = document.getElementById(`veoImageUrls-${index}`);
    let imageUrls = [];
    if (imageUrlsInput) {
        const urls = imageUrlsInput.value.trim();
        if (urls) {
            imageUrls = urls.split('\n').map(url => url.trim()).filter(url => url);
        }
    }

    // UI 状态
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 生成中...';
    contentDiv.classList.remove('d-none');
    contentDiv.innerHTML = `<div class="progress mb-2" style="height: 5px;"><div class="progress-bar progress-bar-striped progress-bar-animated" style="width: 50%"></div></div><div class="text-muted small">Veo正在渲染视频...</div>`;
    statusBadge.className = 'badge bg-warning text-dark';
    statusBadge.innerText = '生成中';

    // 启动可中断的操作
    const abortSignal = beginCancelableOp(`Veo生成视频 #${index + 1}`);

    try {
        const result = await createVeoTask(veoKey, veoModel, scene.video_prompt, veoMode, veoExtendImg, veoTranslate, videoRatio, imageUrls, abortSignal);

        // 检查返回结果类型
        if (result && result.type === 'direct' && result.url) {
            // 直接返回了视频URL
            updateVideoUI(index, 'SUCCESS', result.url, null);
            videoTasks[index] = { url: result.url, status: 'SUCCESS' };
            return { status: 'SUCCESS', url: result.url };
        } else if (result && typeof result === 'string') {
            // 返回了任务ID，需要轮询
            const taskId = result;
            videoTasks[index] = { taskId, status: 'PROCESSING' };
            statusBadge.innerText = '生成中';
            contentDiv.innerHTML = `<div class="progress mb-2" style="height: 5px;"><div class="progress-bar progress-bar-striped progress-bar-animated bg-warning" style="width: 50%"></div></div><div class="text-muted small">Veo渲染中，请稍候...</div>`;

            // 返回一个"完成Promise"，方便批量模式做真正的并发控制
            return pollVeoResult(veoKey, taskId, index, abortSignal);
        }

        throw new Error("Veo返回结果格式错误");

    } catch (e) {
        console.error(e);
        const statusBadge = document.getElementById(`video-status-${index}`);
        const contentDiv = document.getElementById(`video-content-${index}`);
        const btn = document.querySelector(`#video-result-area-${index} button`);
        statusBadge.className = 'badge bg-danger';
        statusBadge.innerText = '失败';
        btn.disabled = false;
        btn.innerHTML = '重试';
        contentDiv.innerHTML = `<span class="text-danger small">${e.message}</span>`;
    }
}

async function generateAllVideos() {
    const zhipuPlatform = document.getElementById('zhipuPlatform');
    const veoPlatform = document.getElementById('veoPlatform');

    // 验证API Key
    if (zhipuPlatform.checked) {
        const zhipuKey = document.getElementById('zhipuApiKey').value.trim();
        if (!zhipuKey) { alert('请先输入智谱 AI API Key'); return; }
    } else if (veoPlatform.checked) {
        const veoKey = document.getElementById('veoApiKey').value.trim();
        if (!veoKey) { alert('请先输入 CQTAI API Key'); return; }
    }

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
    const rawContent = topicInput.value.trim(); 
    
    const instructionInput = document.getElementById('topic-optimize-input');
    const instruction = instructionInput.value.trim();

    if (!rawContent && !instruction) {
        alert('请先输入一些基础想法或优化指令');
        return;
    }

    const btn = document.getElementById('do-topic-optimize-btn');
    const undoBtn = document.getElementById('undo-topic-btn');
    const originalIcon = btn.innerHTML;
    
    // 提示文案改为“灵感发散中”，暗示这是一个多选项的过程
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 灵感发散中...';

    try {
        const abortSignal = beginCancelableOp('优化视频创意');
        lastTopicContent = rawContent;

        // --- 核心修改：System Prompt 改为“灵感库”模式 ---
        const systemPrompt = `你是一位**视觉灵感缪斯**。用户的输入只是一个基础想法，你需要提供**多样化、发散性**的视觉参考，而不是固定某一种风格。

你的目标是建立一个“视觉关键词库”，供后续创作自由选择。

请严格按照以下格式输出（不要写长难句，只列出关键词和选项）：

**原始核心**：[简练概括用户原本的内容，不做改动]

**风格方向参考（提供3种截然不同的可能性）**：
> *方向A（写实/电影感）*：[列出关键词。如：8K分辨率、IMAX画幅、真实光影、物理渲染]
> *方向B（艺术/风格化）*：[列出关键词。如：油画质感、赛博朋克、黑白黑色电影、定格动画]
> *方向C（情绪/抽象）*：[列出关键词。如：梦幻光斑、极简主义、意识流、故障艺术]

**氛围与情绪关键词（Tag Cloud）**：
[列出10-15个形容词，涵盖不同侧面。如：孤独的、宏大的、诡异的、温馨的、易碎的、粗糙的...]

**光影与镜头灵感**：
* [光影]：[提供多种光效选择，如：丁达尔光 / 霓虹侧光 / 柔和漫射光]
* [运镜]：[提供多种视角建议，如：上帝视角 / 蚂蚁视角 / 希区柯克变焦]

**原则**：
1. **不做决定**：不要说“建议采用...”，而是列出“可以是...也可以是...”。
2. **保留可能性**：让用户觉得这个创意既可以拍成科幻片，也可以拍成文艺片。
3. **格式整洁**：使用列表和短语，方便一眼扫视。`;

        const userPrompt = `
用户原始内容：${rawContent || '（用户未提供，请基于指令提供通用灵感）'}
额外指令：${instruction || '请提供丰富的视觉参考方向'}

请输出灵感参考方案：`;

        // 适当增加 max_tokens，因为要输出多种选项
        const optimizedText = await callDeepSeek(apiKey, systemPrompt, userPrompt, 1500, 60000, abortSignal);
        
        const cleanText = optimizedText.replace(/^["']|["']$/g, '').trim();
        
        // 只要包含关键词就认为成功
        if (cleanText.includes('风格方向') || cleanText.includes('原始核心')) {
            topicInput.value = cleanText;
            
            topicInput.classList.add('bg-success', 'bg-opacity-10');
            setTimeout(() => topicInput.classList.remove('bg-success', 'bg-opacity-10'), 500);

            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else {
            // 兜底
            topicInput.value = cleanText;
        }

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

// 创建Veo视频任务
async function createVeoTask(apiKey, model, prompt, mode, enableExtendImg, enableTranslation, ratio, imageUrls) {
    const url = VEO_BASE_URL;

    // 检查是否包含Base64图片
    const hasBase64 = imageUrls && imageUrls.some(url => url.startsWith('data:image/'));
    
    if (hasBase64) {
        throw new Error('Veo API不支持Base64格式的图片。请先将图片上传到图床（如imgur、图壳等），获取公开的图片URL后使用。');
    }

    // 构建请求体 - 根据CQTAI文档格式
    const requestBody = {
        model: model,
        prompt: prompt,
        aspectRatio: ratio,  // 视频尺寸：支持 16:9, 9:16, 1:1, 3:4, 4:3
        enableExtendImg: enableExtendImg || false,  // 将图片扩展成目标比例
        enableTranslation: enableTranslation !== undefined ? enableTranslation : true  // prompt自动翻译成英文，默认启用
    };

    // 添加图片URL（如果有）
    if (imageUrls && imageUrls.length > 0) {
        requestBody.imageUrls = imageUrls;
    }

    // 根据模式调整参数
    if (mode === 'image-to-video' && imageUrls && imageUrls.length > 0) {
        // 图生视频模式：使用第一张图片
        requestBody.imageUrls = [imageUrls[0]];
    } else if (mode === 'first-last-frame' && imageUrls && imageUrls.length >= 2) {
        // 首尾帧模式：使用两张图片
        requestBody.imageUrls = [imageUrls[0], imageUrls[1]];
    }

    console.log("Veo请求参数:", JSON.stringify(requestBody, null, 2));

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    console.log("Veo响应状态:", response.status);

    if (!response.ok) {
        const errText = await response.text();
        console.error("Veo API错误:", errText);
        throw new Error(`Veo API错误 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log("Veo完整响应:", JSON.stringify(data, null, 2));

    // 检查返回的数据结构
    // Veo生成视频的实际返回格式：{ code: 200, msg: "success", data: "53015c849175413da0f67acc852d37e5" }
    // data直接是字符串ID，不是对象
    if (data.code === 200 && data.data) {
        const taskId = data.data;  // data直接就是ID字符串

        console.log("返回任务ID:", taskId);

        // 直接返回任务ID，需要轮询
        return taskId;
    }

    throw new Error("Veo返回数据格式无法解析: " + JSON.stringify(data));
}

// 轮询Veo视频结果（如果API返回的是任务ID）
async function pollVeoResult(apiKey, taskId, index, abortSignal) {
    let retryCount = 0;

    // 轮询策略: 3秒轮询一次,最多20分钟
    return await new Promise((resolve) => {
        const intervalId = setInterval(async () => {
            try {
                // 检查是否被中断
                if (abortSignal && abortSignal.aborted) {
                    clearInterval(intervalId);
                    updateVideoUI(index, 'TIMEOUT', null, "用户中断了生成");
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                if (retryCount >= 400) { // 约 20分钟超时 (400 * 3s)
                    clearInterval(intervalId);
                    updateVideoUI(index, 'TIMEOUT', null, null);
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                // 使用GET请求查询任务状态，需要在URL中添加id参数
                const queryUrl = `${VEO_INFO_URL}?id=${taskId}`;
                console.log("查询URL:", queryUrl);

                const res = await fetch(queryUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/json'
                    }
                });

                if (!res.ok) {
                    console.error("查询响应错误:", res.status);
                    return;
                }

                const data = await res.json();

                // Veo的实际返回格式：{ code: 200, msg: "success", data: { id, resultUrl, status, ... } }
                // 返回单个对象，不是数组
                if (data.code === 200 && data.data) {
                    const task = data.data;

                    console.log("Veo任务状态:", task.status, "任务ID:", task.id);

                    // 检查状态
                    if (task.status === 'succeeded' || task.status === 'completed') {
                        clearInterval(intervalId);
                        const videoUrl = task.resultUrl || task.video_url || task.url || null;
                        console.log("视频URL:", videoUrl);
                        updateVideoUI(index, 'SUCCESS', videoUrl, null);
                        resolve({ status: 'SUCCESS', url: videoUrl });
                    } else if (task.status === 'failed' || task.status === 'error') {
                        clearInterval(intervalId);
                        const errorMsg = task.errorMsg || data.msg || "生成失败";
                        console.error("任务失败:", errorMsg);
                        updateVideoUI(index, 'FAIL', null, errorMsg);
                        resolve({ status: 'FAIL', url: null, error: errorMsg });
                    } else if (task.status === 'running' || task.status === 'processing' || task.status === 'pending') {
                        // 继续轮询
                        console.log("任务进行中，继续轮询...");
                    } else {
                        console.log("未知状态:", task.status, "继续轮询");
                    }
                } else if (data.code === 0 || data.code === 500 || data.code >= 400) {
                    // 错误响应：code为0、500或4xx都表示失败
                    clearInterval(intervalId);
                    const errorMsg = data.msg || "查询失败";
                    console.error("查询错误 (code " + data.code + "):", errorMsg);

                    // 尝试从data中获取更详细的错误信息
                    let detailedError = errorMsg;
                    if (data.data && data.data.errorMsg) {
                        detailedError = data.data.errorMsg;
                    }

                    updateVideoUI(index, 'FAIL', null);
                    resolve({ status: 'FAIL', url: null, error: detailedError });
                } else {
                    console.log("未知响应:", JSON.stringify(data));
                }

                retryCount++;
            } catch (e) {
                console.error("轮询Veo结果时出错:", e);
            }
        }, 3000); // 3秒轮询一次
    });
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
                    updateVideoUI(index, 'TIMEOUT', null, null);
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!res.ok) return;

                const data = await res.json();
                if (data.task_status === 'SUCCESS') {
                    clearInterval(intervalId);
                    const videoUrl = data.video_result?.[0]?.url || null;
                    updateVideoUI(index, 'SUCCESS', videoUrl, null);
                    resolve({ status: 'SUCCESS', url: videoUrl });
                } else if (data.task_status === 'FAIL') {
                    clearInterval(intervalId);
                    const errorMsg = data.error_msg || data.message || "生成失败";
                    updateVideoUI(index, 'FAIL', null, errorMsg);
                    resolve({ status: 'FAIL', url: null, error: errorMsg });
                }
                retryCount++;
            } catch (e) {
                console.error(e);
            }
        }, 3000); // 3秒轮询一次
    });
}

function updateVideoUI(index, status, url, error) {
    const statusBadge = document.getElementById(`video-status-${index}`);
    const contentDiv = document.getElementById(`video-content-${index}`);
    const btn = document.querySelector(`#video-result-area-${index} button`);

    if (status === 'SUCCESS') {
        statusBadge.className = 'badge bg-success'; statusBadge.innerText = '完成';
        btn.innerHTML = '<i class="bi bi-check-lg"></i> 完成';

        // 确保contentDiv可见
        contentDiv.classList.remove('d-none');

        // 添加视频播放器和下载按钮
        contentDiv.innerHTML = `
            <div class="video-player-wrapper mb-3">
                <video src="${url}" controls class="w-100 rounded shadow-sm" preload="metadata">
                    您的浏览器不支持视频标签。
                </video>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-2">
                <small class="text-muted">
                    <i class="bi bi-film"></i> 视频已生成完成
                </small>
                <a href="${url}" download="scene_${index}.mp4" class="btn btn-sm btn-success" target="_blank">
                    <i class="bi bi-download"></i> 下载视频
                </a>
            </div>
            <div class="mt-2">
                <a href="${url}" target="_blank" class="btn btn-sm btn-outline-primary w-100">
                    <i class="bi bi-box-arrow-up-right"></i> 在新窗口打开视频
                </a>
            </div>
        `;
    } else if (status === 'FAIL') {
        statusBadge.className = 'badge bg-danger'; statusBadge.innerText = '失败';
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 重试';
        contentDiv.classList.remove('d-none');

        // 显示详细的错误信息
        const errorMessage = error || "生成失败";
        contentDiv.innerHTML = `
            <div class="alert alert-danger mb-3">
                <h6 class="alert-heading"><i class="bi bi-exclamation-triangle"></i> 视频生成失败</h6>
                <p class="mb-2">${escapeHtml(errorMessage)}</p>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-danger" onclick="generateSingleVideo(${index})">
                        <i class="bi bi-arrow-counterclockwise"></i> 重试生成
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="toggleErrorDetails(${index})">
                        <i class="bi bi-info-circle"></i> 查看详细信息
                    </button>
                </div>
                <div id="error-details-${index}" class="d-none mt-2">
                    <small class="text-muted">
                        <strong>错误代码：</strong>${error ? error.substring(0, 50) : '未知'}<br>
                        <strong>建议：</strong><br>
                        1. 检查API Key是否正确<br>
                        2. 检查prompt内容是否合适<br>
                        3. 尝试更换模型或参数
                    </small>
                </div>
            </div>
        `;
    } else if (status === 'TIMEOUT') {
        statusBadge.className = 'badge bg-secondary'; statusBadge.innerText = '超时';
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 重试';
        contentDiv.classList.remove('d-none');
        contentDiv.innerHTML = `
            <div class="alert alert-warning mb-3">
                <h6 class="alert-heading"><i class="bi bi-clock"></i> 生成超时</h6>
                <p class="mb-2">视频生成超过了20分钟超时限制。</p>
                <button class="btn btn-sm btn-warning" onclick="generateSingleVideo(${index})">
                    <i class="bi bi-arrow-counterclockwise"></i> 重试生成
                </button>
            </div>
        `;
    }

    // 同步任务状态，方便批量逻辑判断
    if (videoTasks[index]) {
        videoTasks[index].status = status;
        videoTasks[index].url = url || null;
        videoTasks[index].error = error || null;
    }
}

// 切换错误详情显示
function toggleErrorDetails(index) {
    const detailsDiv = document.getElementById(`error-details-${index}`);
    if (detailsDiv) {
        detailsDiv.classList.toggle('d-none');
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
            // 外部中断（用户点击"中断"）时，联动取消本次请求
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

/**
 * 下载图片（通过fetch获取blob后下载）
 */
async function downloadImage(url, filename) {
    try {
        console.log('开始下载图片:', url);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`下载失败: ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        URL.revokeObjectURL(blobUrl);

        console.log('图片下载成功:', filename);

        // 显示成功提示
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
        toast.innerHTML = `
            <i class="bi bi-download"></i> 图片已下载: ${filename}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);

    } catch (error) {
        console.error('下载图片失败:', error);

        // 失败时尝试在新窗口打开
        const toast = document.createElement('div');
        toast.className = 'alert alert-warning alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 350px;';
        toast.innerHTML = `
            <i class="bi bi-exclamation-triangle"></i> 自动下载失败，已在新窗口打开图片<br>
            <small>请手动右键保存图片</small>
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);

        window.open(url, '_blank');
    }
}
// 处理图片上传
function handleImageUpload(index) {
    const fileInput = document.getElementById(`veoImageUpload-${index}`);
    const previewContainer = document.getElementById(`image-preview-${index}`);
    const urlTextarea = document.getElementById(`veoImageUrls-${index}`);

    if (!fileInput || !previewContainer || !urlTextarea) return;

    const files = fileInput.files;
    if (!files || files.length === 0) return;

    // 清空预览区
    previewContainer.innerHTML = '';
    const imageUrls = [];

    // 处理每个上传的文件
    Array.from(files).slice(0, 2).forEach((file, i) => {
        // 限制最多2张图片
        const reader = new FileReader();

        reader.onload = (e) => {
            const base64 = e.target.result;

            // 创建预览图片
            const previewImg = document.createElement('img');
            previewImg.src = base64;
            previewImg.className = 'border rounded';
            previewImg.style.width = '100px';
            previewImg.style.height = '100px';
            previewImg.style.objectFit = 'cover';

            // 添加删除按钮
            const wrapper = document.createElement('div');
            wrapper.className = 'position-relative d-inline-block';
            wrapper.appendChild(previewImg);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-sm btn-danger position-absolute top-0 end-0 m-1';
            deleteBtn.innerHTML = '×';
            deleteBtn.style.borderRadius = '50%';
            deleteBtn.style.width = '24px';
            deleteBtn.style.height = '24px';
            deleteBtn.style.padding = '0';
            deleteBtn.onclick = () => {
                wrapper.remove();
                updateImageUrlList(index);
            };

            wrapper.appendChild(deleteBtn);
            previewContainer.appendChild(wrapper);

            // 添加到URL列表
            imageUrls.push(base64);
            updateImageUrlList(index, imageUrls);
        };

        reader.readAsDataURL(file);
    });

    // 如果上传超过2张，提示用户
    if (files.length > 2) {
        alert('最多支持上传2张图片（首尾帧模式需要2张，图生视频模式只需1张）');
    }
}

// 更新图片URL列表
function updateImageUrlList(index, urls) {
    const previewContainer = document.getElementById(`image-preview-${index}`);
    const urlTextarea = document.getElementById(`veoImageUrls-${index}`);

    if (!previewContainer || !urlTextarea) return;

    // 如果没有提供urls参数，从预览区提取
    if (!urls) {
        const images = previewContainer.querySelectorAll('img');
        urls = Array.from(images).map(img => img.src);
    }

    // 更新URL文本框
    urlTextarea.value = urls.join('\n');
}

function exportResult() {
    if (!globalScenes) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({concept: globalConcept, scenes: globalScenes}, null, 2));
    const a = document.createElement('a');
    a.href = dataStr; a.download = "storyboard_export.json";
    document.body.appendChild(a); a.click(); a.remove();
}

// 中断Veo视频生成
function cancelVeoGeneration(index, controllerName) {
    try {
        // 获取AbortController
        // 由于我们使用全局的可中断机制，这里直接调用cancelCurrentOp
        cancelCurrentOp();

        // 更新UI显示中断状态
        const statusBadge = document.getElementById(`video-status-${index}`);
        const contentDiv = document.getElementById(`video-content-${index}`);
        const btn = document.querySelector(`#video-result-area-${index} button`);

        statusBadge.className = 'badge bg-secondary';
        statusBadge.innerText = '已中断';
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 重新生成';

        contentDiv.innerHTML = `
            <div class="alert alert-warning mb-3">
                <h6 class="alert-heading"><i class="bi bi-info-circle"></i> 生成已中断</h6>
                <p class="mb-2">视频生成已被手动中断，您可以修改参数后重新生成。</p>
                <button class="btn btn-sm btn-warning" onclick="generateSingleVideo(${index})">
                    <i class="bi bi-arrow-counterclockwise"></i> 重新生成
                </button>
            </div>
        `;
    } catch (e) {
        console.error("中断失败:", e);
    }
}

// ==========================================
// 文生图功能 (Nano API)
// ==========================================

// 生成Nano图片
async function generateNanoImages() {
    const cqtaiKey = document.getElementById('veoApiKey').value.trim();
    if (!cqtaiKey) {
        alert('请输入 CQTAI API Key');
        return;
    }

    const prompt = document.getElementById('nanoPrompt').value.trim();
    if (!prompt) {
        alert('请输入图片描述');
        return;
    }

    // 检测当前模式
    const isImageToImage = document.getElementById('imageToImageMode').checked;

    // 如果是图生图模式，检查是否上传了参考图片
    if (isImageToImage) {
        const uploadedImage = getUploadedImage();
        if (!uploadedImage) {
            alert('请先上传参考图片！');
            return;
        }
    }

    const model = document.getElementById('nanoModel').value;
    const aspectRatio = document.getElementById('nanoAspectRatio').value;
    const resolution = document.getElementById('nanoResolution').value;
    const numImages = parseInt(document.getElementById('nanoNumImages').value);

    // 显示结果区域
    const resultSection = document.getElementById('imageResultSection');
    const resultsContainer = document.getElementById('imageResultsContainer');
    resultSection.classList.remove('d-none');

    // 获取当前已有成功的图片数量，用于继续生成
    const existingCards = resultsContainer.querySelectorAll('[id^="nano-card-"]');
    const startIndex = existingCards.length;

    // 为每张图片创建一个占位卡片（追加到已有结果后面）
    for (let i = 0; i < numImages; i++) {
        const cardIndex = startIndex + i;
        const cardCol = document.createElement('div');
        cardCol.className = 'col-md-6 col-lg-4 draggable-image-card';
        cardCol.draggable = true;
        cardCol.dataset.index = cardIndex;
        cardCol.innerHTML = `
            <div class="card h-100" id="nano-card-${cardIndex}">
                <div class="card-body text-center">
                    <div class="placeholder-glow">
                        <div class="placeholder bg-secondary rounded" style="height: 300px; width: 100%;"></div>
                    </div>
                    <p class="mt-2 text-muted small">
                        <span class="spinner-border spinner-border-sm"></span> 正在${isImageToImage ? '图生图' : '文生图'} ${cardIndex + 1}...
                    </p>
                </div>
            </div>
        `;
        resultsContainer.appendChild(cardCol);

        // 添加拖拽事件监听
        setupDragSort(cardCol);
    }

    try {
        const abortSignal = beginCancelableOp(isImageToImage ? '图生图生成' : '文生图生成');

        // 并发生成多张图片
        const promises = [];
        for (let i = 0; i < numImages; i++) {
            promises.push(createNanoTask(cqtaiKey, model, prompt, aspectRatio, resolution, startIndex + i, abortSignal, isImageToImage));
        }

        await Promise.all(promises);

    } catch (error) {
        console.error(error);
        if (!String(error?.message || '').includes('已中断')) {
            alert('图片生成失败：' + error.message);
        }
    } finally {
        endCancelableOp();
    }
}

// 创建Nano图片生成任务
async function createNanoTask(apiKey, model, prompt, aspectRatio, resolution, imageIndex, abortSignal, isImageToImage = false) {
    const url = NANO_BASE_URL;

    // 构建请求体
    const requestBody = {
        model: model,
        prompt: prompt,
        aspectRatio: aspectRatio,
        resolution: resolution,
        numImages: 1  // 每次请求只生成1张图片
    };

    // 如果是图生图模式，添加参考图片URL
    if (isImageToImage) {
        const uploadedImage = getUploadedImage();
        if (uploadedImage) {
            requestBody.filesUrl = [uploadedImage];
            console.log(`图生图模式，使用参考图片`);
        }
    }

    console.log(`Nano请求参数 (图片 ${imageIndex}):`, JSON.stringify(requestBody, null, 2));

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    console.log(`Nano响应状态 (图片 ${imageIndex}):`, response.status);

    if (!response.ok) {
        const errText = await response.text();
        console.error("Nano API错误:", errText);
        throw new Error(`Nano API错误 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log(`Nano完整响应 (图片 ${imageIndex}):`, JSON.stringify(data, null, 2));

    // 检查返回的数据结构
    if (data.code === 200 && data.data) {
        const taskId = data.data;

        console.log(`Nano返回任务ID (图片 ${imageIndex}):`, taskId);

        // 轮询结果
        return pollNanoResult(apiKey, taskId, imageIndex, abortSignal);
    }

    throw new Error("Nano返回数据格式无法解析: " + JSON.stringify(data));
}

// 轮询Nano图片生成结果
async function pollNanoResult(apiKey, taskId, imageIndex, abortSignal) {
    let retryCount = 0;

    // 轮询策略: 3秒轮询一次，最多10分钟
    return await new Promise((resolve) => {
        const intervalId = setInterval(async () => {
            try {
                // 检查是否被中断
                if (abortSignal && abortSignal.aborted) {
                    clearInterval(intervalId);
                    updateNanoImageUI(imageIndex, 'TIMEOUT', null, "用户中断了生成");
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                if (retryCount >= 200) { // 约 10分钟超时 (200 * 3s)
                    clearInterval(intervalId);
                    updateNanoImageUI(imageIndex, 'TIMEOUT', null, null);
                    resolve({ status: 'TIMEOUT', url: null });
                    return;
                }

                // 使用GET请求查询任务状态
                const queryUrl = `${NANO_INFO_URL}?id=${taskId}`;
                console.log(`Nano查询URL (图片 ${imageIndex}):`, queryUrl);

                const res = await fetch(queryUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/json'
                    }
                });

                if (!res.ok) {
                    console.error(`Nano查询响应错误 (图片 ${imageIndex}):`, res.status);
                    return;
                }

                const data = await res.json();

                if (data.code === 200 && data.data) {
                    const task = data.data;

                    console.log(`Nano任务状态 (图片 ${imageIndex}):`, task.status, "任务ID:", task.id);

                    // 检查状态
                    if (task.status === 'succeeded' || task.status === 'completed') {
                        clearInterval(intervalId);
                        const imageUrl = task.resultUrl || task.url || null;
                        console.log(`Nano图片URL (图片 ${imageIndex}):`, imageUrl);
                        updateNanoImageUI(imageIndex, 'SUCCESS', imageUrl, null);
                        resolve({ status: 'SUCCESS', url: imageUrl });
                    } else if (task.status === 'failed' || task.status === 'error') {
                        clearInterval(intervalId);
                        const errorMsg = task.errorMsg || data.msg || "生成失败";
                        console.error(`Nano任务失败 (图片 ${imageIndex}):`, errorMsg);
                        updateNanoImageUI(imageIndex, 'FAIL', null, errorMsg);
                        resolve({ status: 'FAIL', url: null, error: errorMsg });
                    } else if (task.status === 'running' || task.status === 'processing' || task.status === 'pending') {
                        // 继续轮询
                        console.log(`Nano任务进行中 (图片 ${imageIndex}), 继续轮询...`);
                    } else {
                        console.log(`Nano未知状态 (图片 ${imageIndex}):`, task.status, "继续轮询");
                    }
                } else if (data.code === 0 || data.code === 500 || data.code >= 400) {
                    // 错误响应
                    clearInterval(intervalId);
                    const errorMsg = data.msg || "查询失败";
                    console.error(`Nano查询错误 (图片 ${imageIndex}, code ` + data.code + "):", errorMsg);
                    updateNanoImageUI(imageIndex, 'FAIL', null);
                    resolve({ status: 'FAIL', url: null, error: errorMsg });
                } else {
                    console.log(`Nano未知响应 (图片 ${imageIndex}):`, JSON.stringify(data));
                }

                retryCount++;
            } catch (e) {
                console.error(`轮询Nano结果时出错 (图片 ${imageIndex}):`, e);
            }
        }, 3000); // 3秒轮询一次
    });
}

// 更新Nano图片UI
function updateNanoImageUI(imageIndex, status, url, error) {
    const cardCol = document.getElementById(`nano-card-${imageIndex}`)?.parentElement;
    const card = document.getElementById(`nano-card-${imageIndex}`);
    if (!card) {
        console.log('未找到卡片元素: nano-card-', imageIndex);
        return;
    }

    console.log('更新卡片UI, 索引:', imageIndex, '状态:', status);

    const cardBody = card.querySelector('.card-body');

    if (status === 'SUCCESS') {
        cardBody.innerHTML = `
            <div class="position-relative">
                <img src="${url}" alt="Generated Image ${imageIndex + 1}" class="img-fluid rounded draggable-generated-image" 
                     style="width: 100%; height: auto; object-fit: cover; cursor: grab;" 
                     draggable="true" 
                     data-image-url="${escapeHtml(url)}"
                     title="拖拽此图片到参考图上传区域">
            </div>
            <div class="mt-3 d-flex justify-content-between align-items-center">
                <small class="text-success">
                    <i class="bi bi-check-circle"></i> 图片已生成
                </small>
                <div class="btn-group">
                    <a href="${url}" download="nano_image_${imageIndex + 1}.png" class="btn btn-sm btn-success" target="_blank">
                        <i class="bi bi-download"></i> 下载
                    </a>
                    <a href="${url}" target="_blank" class="btn btn-sm btn-outline-primary">
                        <i class="bi bi-box-arrow-up-right"></i> 查看
                    </a>
                </div>
            </div>
        `;
        
        // 为生成的图片绑定拖拽事件，使其可以拖拽到上传区域
        const imgElement = cardBody.querySelector('.draggable-generated-image');
        if (imgElement) {
            setupImageDragToUpload(imgElement, url);
        }

        // 确保外层容器有拖拽属性和事件（关键修复）
        if (cardCol) {
            console.log('检查外层容器的拖拽属性...');

            // 确保有必要的类和属性
            if (!cardCol.classList.contains('draggable-image-card')) {
                console.log('添加 draggable-image-card 类');
                cardCol.classList.add('draggable-image-card');
            }

            if (!cardCol.draggable) {
                console.log('设置 draggable 属性');
                cardCol.draggable = true;
            }

            // 重新绑定拖拽事件（确保事件都正确绑定）
            console.log('重新绑定拖拽事件到外层容器');
            // 移除旧的事件监听器
            const newCardCol = cardCol.cloneNode(true);
            cardCol.parentNode.replaceChild(newCardCol, cardCol);
            setupDragSort(newCardCol);

            // 添加拖拽手柄图标，提示可以拖拽
            const existingHandle = cardBody.querySelector('.drag-handle');
            if (!existingHandle) {
                const dragHandle = document.createElement('div');
                dragHandle.className = 'drag-handle position-absolute';
                dragHandle.style.cssText = 'top: 10px; right: 10px; background: rgba(66, 133, 244, 0.9); color: white; border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: move; box-shadow: 0 2px 4px rgba(0,0,0,0.2); z-index: 10; pointer-events: none;';
                dragHandle.innerHTML = '<i class="bi bi-grip-vertical"></i>';
                cardBody.style.position = 'relative';
                cardBody.appendChild(dragHandle);
                console.log('已添加拖拽手柄');
            }

            console.log('卡片UI更新完成，拖拽功能已重新绑定');
        }
    } else if (status === 'FAIL') {
        cardBody.innerHTML = `
            <div class="alert alert-danger text-center" style="height: 300px; display: flex; align-items: center; justify-content: center;">
                <div>
                    <i class="bi bi-exclamation-triangle display-4"></i>
                    <p class="mt-2 mb-0">图片生成失败</p>
                    ${error ? `<small class="text-muted">${escapeHtml(error).substring(0, 50)}</small>` : ''}
                </div>
            </div>
            <button class="btn btn-sm btn-outline-danger mt-2 w-100" onclick="retryNanoImage(${imageIndex})">
                <i class="bi bi-arrow-counterclockwise"></i> 重试
            </button>
        `;
    } else if (status === 'TIMEOUT') {
        cardBody.innerHTML = `
            <div class="alert alert-warning text-center" style="height: 300px; display: flex; align-items: center; justify-content: center;">
                <div>
                    <i class="bi bi-clock display-4"></i>
                    <p class="mt-2 mb-0">生成超时</p>
                    <small>超过了10分钟的超时限制</small>
                </div>
            </div>
            <button class="btn btn-sm btn-outline-warning mt-2 w-100" onclick="retryNanoImage(${imageIndex})">
                <i class="bi bi-arrow-counterclockwise"></i> 重试
            </button>
        `;
    }
}

// 重试生成Nano图片
function retryNanoImage(imageIndex) {
    const cqtaiKey = document.getElementById('veoApiKey').value.trim();
    if (!cqtaiKey) {
        alert('请输入 CQTAI API Key');
        return;
    }

    const prompt = document.getElementById('nanoPrompt').value.trim();
    if (!prompt) {
        alert('请输入图片描述');
        return;
    }

    const model = document.getElementById('nanoModel').value;
    const aspectRatio = document.getElementById('nanoAspectRatio').value;
    const resolution = document.getElementById('nanoResolution').value;

    // 获取指定索引的卡片
    const card = document.getElementById(`nano-card-${imageIndex}`);
    if (!card) return;

    const cardBody = card.querySelector('.card-body');

    // 重置卡片状态为生成中
    cardBody.innerHTML = `
        <div class="placeholder-glow">
            <div class="placeholder bg-secondary rounded" style="height: 300px; width: 100%;"></div>
        </div>
        <p class="mt-2 text-muted small">
            <span class="spinner-border spinner-border-sm"></span> 正在重新生成图片 ${imageIndex + 1}...
        </p>
    `;

    // 异步重试生成
    createNanoTask(cqtaiKey, model, prompt, aspectRatio, resolution, imageIndex, null)
        .catch(error => {
            console.error('重试失败:', error);
        });
}

// 清空图片结果
function clearImageResults() {
    if (!confirm('确定要清空所有图片吗？包括已成功生成的图片。')) {
        return;
    }
    const resultsContainer = document.getElementById('imageResultsContainer');
    if (resultsContainer) {
        resultsContainer.innerHTML = '';
    }
    document.getElementById('imageResultSection').classList.add('d-none');
}

// 只清除失败的图片
function clearFailedImages() {
    const resultsContainer = document.getElementById('imageResultsContainer');
    if (!resultsContainer) return;

    const cards = resultsContainer.querySelectorAll('[id^="nano-card-"]');
    let failedCount = 0;

    cards.forEach(card => {
        // 检查卡片中是否包含失败或超时的标识
        const cardBody = card.querySelector('.card-body');
        if (cardBody && (cardBody.querySelector('.alert-danger') || cardBody.querySelector('.alert-warning'))) {
            card.remove();
            failedCount++;
        }
    });

    // 如果清空后没有卡片了，隐藏结果区域
    const remainingCards = resultsContainer.querySelectorAll('[id^="nano-card-"]');
    if (remainingCards.length === 0) {
        document.getElementById('imageResultSection').classList.add('d-none');
    }

    if (failedCount > 0) {
        // 显示成功提示
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
        toast.innerHTML = `
            <i class="bi bi-check-circle"></i> 已清除 ${failedCount} 张失败的图片
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}

// ==========================================
// 拖拽上传功能
// ==========================================

let dropZoneInitialized = false;  // 标记是否已初始化

function setupDragAndDrop() {
    const dropZone = document.getElementById('dropZone');

    if (!dropZone) {
        console.log('警告：找不到拖拽区域元素 #dropZone');
        return;
    }

    // 防止重复绑定
    if (dropZoneInitialized) {
        console.log('拖拽区域已初始化，跳过重复绑定');
        return;
    }

    console.log('初始化拖拽上传区域');

    // 阻止默认行为
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        console.log('已绑定事件:', eventName);
    });

    // 使用dragover来持续高亮（更可靠）
    dropZone.addEventListener('dragover', (e) => {
        console.log('拖拽悬停，添加高亮');
        dropZone.classList.add('drop-zone-active');
    }, false);

    // drop事件处理
    dropZone.addEventListener('drop', (e) => {
        console.log('放下文件到上传区域');
        dropZone.classList.remove('drop-zone-active');
        // 阻止事件冒泡，避免触发其他拖拽处理
        e.stopPropagation();
        handleDrop(e);
    }, false);

    // 可选：dragenter进入高亮
    dropZone.addEventListener('dragenter', (e) => {
        console.log('拖拽进入区域');
        dropZone.classList.add('drop-zone-active');
    }, false);

    // dragleave离开移除高亮（可选，dragover已经处理了）
    dropZone.addEventListener('dragleave', (e) => {
        console.log('拖拽离开区域');
        // 只有真正离开时才移除（不是进入子元素）
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove('drop-zone-active');
        }
    }, false);

    // 标记为已初始化
    dropZoneInitialized = true;
    console.log('拖拽上传区域初始化完成');
}

function preventDefaults(e) {
    console.log('阻止默认行为');
    e.preventDefault();
    e.stopPropagation();
}

function handleDrop(e) {
    console.log('=== 文件放下事件触发 ===');
    const dt = e.dataTransfer;

    // 首先尝试获取URL（从网页元素拖拽的图片）
    const textPlain = dt.getData('text/plain');
    const textUri = dt.getData('text/uri-list');
    const htmlData = dt.getData('text/html');

    console.log('=== 拖拽数据分析 ===');
    console.log('text/plain:', textPlain);
    console.log('text/uri-list:', textUri);
    console.log('text/html:', htmlData);
    console.log('files:', dt.files);

    // 提取图片URL的优先级
    let imageUrl = null;

    // 1. 从text/plain获取（如果它是URL）
    if (textPlain && (textPlain.trim().startsWith('http://') || textPlain.trim().startsWith('https://'))) {
        imageUrl = textPlain.trim();
        console.log('从text/plain提取URL:', imageUrl);
    }
    // 2. 从text/uri-list获取
    else if (textUri && (textUri.trim().startsWith('http://') || textUri.trim().startsWith('https://'))) {
        imageUrl = textUri.trim();
        console.log('从text/uri-list提取URL:', imageUrl);
    }
    // 3. 从HTML数据提取
    else if (htmlData) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlData, 'text/html');
        const img = doc.querySelector('img');
        if (img && img.src && (img.src.startsWith('http://') || img.src.startsWith('https://'))) {
            imageUrl = img.src;
            console.log('从HTML中提取图片URL:', imageUrl);
        }
    }

    // 如果提取到了URL，直接使用（优先级最高）
    if (imageUrl) {
        console.log('✅ 检测到图片URL，直接使用:', imageUrl);
        handleImageUrlUpload(imageUrl);
        return;
    }

    // 如果没有URL，处理文件上传
    const files = dt.files;
    console.log('files 数量:', files ? files.length : 0);

    if (files && files.length > 0) {
        console.log('开始处理文件上传...');
        handleFileUpload(files);
        return;
    }

    console.warn('⚠️ 没有检测到文件或图片URL');
    console.warn('收到的数据:', {
        textPlain: textPlain?.substring(0, 100),
        textUri: textUri?.substring(0, 100),
        htmlData: htmlData?.substring(0, 100)
    });
}

// 处理从URL上传图片（用于从网页元素拖拽）
async function handleImageUrlUpload(imageUrl) {
    console.log('处理图片URL上传:', imageUrl);

    // 如果是Base64数据，直接使用
    if (imageUrl.startsWith('data:image/')) {
        console.log('检测到Base64图片数据');
        addImagePreview(imageUrl, 'generated_image.png');
        return;
    }

    // 如果是HTTP/HTTPS URL，直接将URL添加到输入框（不转换Base64）
    // 因为Veo API本身就支持公开URL，这样更简单高效，避免CORS问题
    console.log('检测到公开URL，直接添加到输入框:', imageUrl);

    // 尝试找到视频生成区域的图片URL输入框
    // 当前是否有正在打开的视频生成区域
    let targetIndex = null;
    const urlTextareas = document.querySelectorAll('[id^="veoImageUrls-"]');
    if (urlTextareas.length > 0) {
        // 找到第一个非空的或者最近操作的
        for (let textarea of urlTextareas) {
            if (textarea.value.trim() === '') {
                targetIndex = textarea.id.replace('veoImageUrls-', '');
                break;
            }
        }
        // 如果没有找到空的，使用最后一个
        if (targetIndex === null) {
            targetIndex = urlTextareas[urlTextareas.length - 1].id.replace('veoImageUrls-', '');
        }
    }

    if (targetIndex !== null) {
        const urlInput = document.getElementById(`veoImageUrls-${targetIndex}`);
        const previewContainer = document.getElementById(`image-preview-${targetIndex}`);

        if (urlInput && previewContainer) {
            // 清空并设置新URL
            urlInput.value = imageUrl;
            console.log(`已将URL添加到分镜 ${parseInt(targetIndex) + 1} 的输入框`);

            // 显示预览图片（直接使用URL，不转换Base64）
            previewContainer.innerHTML = '';

            const wrapper = document.createElement('div');
            wrapper.className = 'position-relative d-inline-block';
            wrapper.innerHTML = `
                <img src="${imageUrl}" alt="Preview Image" class="border rounded"
                     style="width: 100px; height: 100px; object-fit: cover;">
                <button class="btn btn-sm btn-danger position-absolute top-0 end-0 m-1"
                        style="border-radius: 50%; width: 24px; height: 24px; padding: 0;"
                        onclick="this.parentElement.remove(); updateImageUrlList(${targetIndex});">×</button>
            `;
            previewContainer.appendChild(wrapper);

            // 更新URL列表
            updateImageUrlList(targetIndex, [imageUrl]);

            // 显示成功提示
            const toast = document.createElement('div');
            toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
            toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
            toast.innerHTML = `
                <i class="bi bi-check-circle"></i> 图片URL已添加到分镜 #${parseInt(targetIndex) + 1}
                <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
            `;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);

            console.log('URL预览已显示');
            return;
        }
    }

    // 如果没有找到视频生成区域，尝试图生图模式的预览区域
    const imageModePreview = document.getElementById('uploadedImagesPreview');
    if (imageModePreview) {
        console.log('使用图生图预览区域显示图片');
        imageModePreview.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'uploaded-image-preview';
        wrapper.style.cssText = 'animation: fadeIn 0.5s ease;';
        wrapper.innerHTML = `
            <img src="${imageUrl}" alt="Reference Image" style="object-fit: cover; max-width: 200px;">
            <button class="delete-btn" onclick="removeUploadedImage()" title="删除图片">×</button>
            <div class="mt-2 p-2 bg-light rounded">
                <small class="text-muted d-block mb-1">图片URL（可直接复制使用）：</small>
                <input type="text" class="form-control form-control-sm font-monospace" value="${escapeHtml(imageUrl)}"
                       readonly style="font-size: 0.85rem; font-family: monospace;"
                       onclick="this.select()">
                <small class="text-primary mt-1 d-block">
                    <i class="bi bi-check-circle"></i> URL已准备好，可直接用于图生视频
                </small>
            </div>
        `;
        imageModePreview.appendChild(wrapper);

        // 显示成功提示
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 350px;';
        toast.innerHTML = `
            <i class="bi bi-check-circle"></i> 图片已添加（URL可直接使用）
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);

        console.log('✅ 图生图预览已显示');
        return;
    }

    // 都没找到
    console.warn('⚠️ 未找到任何预览区域');
    alert('图片URL已获取：\n\n' + imageUrl + '\n\n请手动复制URL到需要的输入框中。');
}

// 使用Cloudflare代理将图片URL转换为Base64（通过代理绕过CORS限制）
async function convertImageUrlToBase64ViaCloudflare(imageUrl) {
    console.log('使用Cloudflare代理转换图片:', imageUrl);

    try {
        // 构建代理URL
        const proxyUrl = `${ZHIPU_BASE_URL}/proxy-image?url=${encodeURIComponent(imageUrl)}`;
        console.log('代理URL:', proxyUrl);

        // 通过代理获取图片
        const response = await fetch(proxyUrl, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error(`代理请求失败: ${response.status} ${response.statusText}`);
        }

        // 获取图片数据并转换为Base64
        const blob = await response.blob();
        const reader = new FileReader();

        reader.onload = (e) => {
            console.log('通过Cloudflare代理成功转换图片');
            addImagePreview(e.target.result, 'generated_image.png');
        };

        reader.onerror = (error) => {
            console.error('Base64转换失败:', error);
            alert('图片转换失败：' + error.message);
        };

        reader.readAsDataURL(blob);

    } catch (error) {
        console.error('Cloudflare代理转换失败:', error);

        // 如果代理失败，尝试直接使用Canvas（作为备选方案）
        console.log('代理失败，尝试直接Canvas加载...');
        convertImageUrlToBase64ViaCanvas(imageUrl);
    }
}

// 使用Canvas API将图片URL转换为Base64（备选方案，可以绕过部分CORS限制）
function convertImageUrlToBase64ViaCanvas(imageUrl) {
    console.log('使用Canvas API转换图片:', imageUrl);

    const img = new Image();
    img.crossOrigin = 'anonymous'; // 允许跨域（如果服务器支持CORS）

    img.onload = function() {
        try {
            // 创建Canvas
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            // 绘制图片到Canvas
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // 转换为Base64
            const base64Data = canvas.toDataURL('image/png');
            console.log('图片转换为Base64成功（通过Canvas）');
            addImagePreview(base64Data, 'generated_image.png');
        } catch (canvasError) {
            console.error('Canvas转换失败:', canvasError);
            alert('图片加载失败：' + canvasError.message + '\n\n如果图片URL是公开可访问的，可以直接在URL输入框中粘贴使用。');
        }
    };

    img.onerror = function(error) {
        console.error('图片加载失败:', error);
        alert('图片加载失败：无法访问该图片URL。\n\n可能的原因：\n1. 图片URL需要CORS支持\n2. 图片URL不可访问\n3. 网络连接问题\n\n建议：如果图片URL是公开可访问的，可以直接在URL输入框中粘贴使用。');
    };

    // 开始加载图片
    img.src = imageUrl;
}

// 处理文件上传
function handleFileUpload(files) {
    if (!files || files.length === 0) {
        console.log('文件上传失败：没有文件');
        return;
    }

    // 限制最多上传1张参考图片（图生图模式）
    const file = files[0];
    console.log('处理文件:', file.name, '类型:', file.type, '大小:', file.size);

    if (!file.type.startsWith('image/')) {
        alert('请上传图片文件！');
        console.log('文件类型错误:', file.type);
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        console.log('文件读取成功，准备显示预览');
        addImagePreview(e.target.result, file.name);
    };
    reader.onerror = (error) => {
        console.error('文件读取失败:', error);
        alert('图片读取失败，请重试！');
    };
    reader.readAsDataURL(file);
}

// 添加图片预览
function addImagePreview(imageData, fileName) {
    const previewContainer = document.getElementById('uploadedImagesPreview');
    if (!previewContainer) {
        console.log('预览容器不存在');
        return;
    }

    console.log('添加图片预览:', fileName);

    // 清空之前的预览
    previewContainer.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'uploaded-image-preview';
    wrapper.style.cssText = 'animation: fadeIn 0.5s ease;';
    wrapper.innerHTML = `
        <img src="${imageData}" alt="${fileName}" style="object-fit: cover;">
        <button class="delete-btn" onclick="removeUploadedImage()" title="删除图片">×</button>
    `;
    previewContainer.appendChild(wrapper);

    console.log('图片预览已添加到页面');

    // 显示成功提示
    const toast = document.createElement('div');
    toast.className = 'alert alert-success alert-dismissible fade show position-fixed';
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
    toast.innerHTML = `
        <i class="bi bi-check-circle"></i> 图片已上传
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// 删除上传的图片
function removeUploadedImage() {
    const previewContainer = document.getElementById('uploadedImagesPreview');
    if (previewContainer) {
        console.log('删除上传的参考图片');

        // 添加淡出动画
        const preview = previewContainer.querySelector('.uploaded-image-preview');
        if (preview) {
            preview.style.transition = 'all 0.3s ease';
            preview.style.opacity = '0';
            preview.style.transform = 'scale(0.9)';

            setTimeout(() => {
                previewContainer.innerHTML = '';
                console.log('参考图片已清空');

                // 显示提示
                const toast = document.createElement('div');
                toast.className = 'alert alert-info alert-dismissible fade show position-fixed';
                toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 300px;';
                toast.innerHTML = `
                    <i class="bi bi-info-circle"></i> 参考图片已删除
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                `;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            }, 300);
        }
    }
}

// 获取上传的图片数据（用于图生图）
function getUploadedImage() {
    const previewContainer = document.getElementById('uploadedImagesPreview');
    if (!previewContainer) return null;

    const img = previewContainer.querySelector('img');
    if (!img) return null;

    return img.src;
}

// ==========================================
// 图片结果拖拽排序功能
// ==========================================

// 使用WeakMap来跟踪每个元素的事件监听器，避免重复绑定
const dragEventListeners = new WeakMap();

function setupDragSort(cardElement) {
    if (!cardElement) return;

    console.log('设置拖拽排序，元素:', cardElement.dataset.index);

    // 如果已经绑定过，先移除
    if (dragEventListeners.has(cardElement)) {
        console.log('移除旧的拖拽事件监听器');
        const listeners = dragEventListeners.get(cardElement);
        cardElement.removeEventListener('dragstart', listeners.dragstart);
        cardElement.removeEventListener('dragend', listeners.dragend);
        cardElement.removeEventListener('dragover', listeners.dragover);
        cardElement.removeEventListener('dragenter', listeners.dragenter);
        cardElement.removeEventListener('dragleave', listeners.dragleave);
        cardElement.removeEventListener('drop', listeners.drop);
    }

    // 定义事件处理函数（保存引用以便后续移除）
    // 使用箭头函数确保this指向cardElement
    const dragStartHandler = (e) => {
        // 检查是否拖拽的是图片元素（而不是整个卡片）
        const img = e.target.closest('.draggable-generated-image');
        if (img) {
            // 如果拖拽的是图片，完全跳过卡片的事件处理
            // 让图片自己的setupImageDragToUpload来处理
            console.log('检测到图片拖拽，跳过卡片事件处理');
            return;
        }

        // 否则是卡片排序拖拽
        draggedItem = cardElement;
        cardElement.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', cardElement.innerHTML);
        console.log('开始拖拽卡片排序:', cardElement.dataset.index);
    };

    const dragEndHandler = (e) => {
        cardElement.classList.remove('dragging');
        draggedItem = null;

        // 移除所有卡片的drag-over样式
        document.querySelectorAll('.draggable-image-card').forEach(card => {
            card.classList.remove('drag-over');
        });

        console.log('拖拽结束');
    };

    const dragOverHandler = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        return false;
    };

    const dragEnterHandler = (e) => {
        if (cardElement !== draggedItem) {
            cardElement.classList.add('drag-over');
        }
    };

    const dragLeaveHandler = (e) => {
        cardElement.classList.remove('drag-over');
    };

    const dropHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();

        cardElement.classList.remove('drag-over');

        console.log('放置元素');
        console.log('拖拽元素:', draggedItem);
        console.log('目标元素:', cardElement);

        if (draggedItem !== cardElement) {
            // 获取容器
            const container = document.getElementById('imageResultsContainer');

            // 获取拖拽项目和目标项目
            const draggedIndex = parseInt(draggedItem.dataset.index);
            const targetIndex = parseInt(cardElement.dataset.index);

            console.log('拖拽索引:', draggedIndex, '目标索引:', targetIndex);

            // 交换位置
            if (draggedIndex < targetIndex) {
                // 向后拖
                container.insertBefore(draggedItem, cardElement.nextSibling);
            } else {
                // 向前拖
                container.insertBefore(draggedItem, cardElement);
            }

            // 更新索引
            updateCardIndices();
        }

        return false;
    };

    // 绑定事件
    cardElement.addEventListener('dragstart', dragStartHandler);
    cardElement.addEventListener('dragend', dragEndHandler);
    cardElement.addEventListener('dragover', dragOverHandler);
    cardElement.addEventListener('dragenter', dragEnterHandler);
    cardElement.addEventListener('dragleave', dragLeaveHandler);
    cardElement.addEventListener('drop', dropHandler);

    // 保存监听器引用
    dragEventListeners.set(cardElement, {
        dragstart: dragStartHandler,
        dragend: dragEndHandler,
        dragover: dragOverHandler,
        dragenter: dragEnterHandler,
        dragleave: dragLeaveHandler,
        drop: dropHandler
    });

    // 添加拖拽手柄样式提示
    cardElement.style.cursor = 'move';

    console.log('拖拽事件已绑定');
}

let draggedItem = null;

// 更新所有卡片的索引
function updateCardIndices() {
    const cards = document.querySelectorAll('.draggable-image-card');
    cards.forEach((card, index) => {
        card.dataset.index = index;
    });
    console.log('已更新卡片索引，共', cards.length, '张');
}

// 为生成的图片设置拖拽到上传区域的功能
function setupImageDragToUpload(imgElement, imageUrl) {
    if (!imgElement) return;

    console.log('为图片设置拖拽功能:', imageUrl);

    // 移除可能存在的旧事件监听器
    const newImg = imgElement.cloneNode(true);
    imgElement.parentNode.replaceChild(newImg, imgElement);

    // 绑定dragstart事件，将图片URL存储到dataTransfer中
    newImg.addEventListener('dragstart', (e) => {
        console.log('=== 开始拖拽生成的图片 ===');
        console.log('拖拽的图片URL:', imageUrl);
        console.log('dataTransfer对象:', e.dataTransfer);

        // 设置拖拽效果
        e.dataTransfer.effectAllowed = 'copyLink'; // 使用copyLink表示链接复制

        // 存储图片URL，支持多种格式以便兼容
        // 注意：必须在事件开始时同步设置，不能异步
        e.dataTransfer.setData('text/plain', imageUrl);
        console.log('已设置 text/plain:', imageUrl);

        e.dataTransfer.setData('text/uri-list', imageUrl);
        console.log('已设置 text/uri-list:', imageUrl);

        // 也存储HTML格式，包含img标签
        const htmlContent = `<img src="${escapeHtml(imageUrl)}" alt="Generated Image">`;
        e.dataTransfer.setData('text/html', htmlContent);
        console.log('已设置 text/html:', htmlContent);

        // 设置拖拽时的视觉效果
        newImg.style.opacity = '0.5';

        console.log('=== dataTransfer设置完成 ===');
    }, false);

    // 拖拽结束时恢复样式
    newImg.addEventListener('dragend', (e) => {
        console.log('拖拽生成的图片结束');
        newImg.style.opacity = '1';
    }, false);

    // 添加视觉提示
    newImg.style.cursor = 'grab';
    newImg.addEventListener('mousedown', () => {
        newImg.style.cursor = 'grabbing';
    });
    newImg.addEventListener('mouseup', () => {
        newImg.style.cursor = 'grab';
    });

    console.log('已为生成的图片设置拖拽到上传区域功能');
}

// 初始化页面加载时已存在的可拖拽卡片
function initializeExistingDraggableCards() {
    // 延迟执行，确保DOM完全加载
    setTimeout(() => {
        const existingCards = document.querySelectorAll('.draggable-image-card');
        console.log('初始化已存在的拖拽卡片，共', existingCards.length, '个');
        existingCards.forEach(card => {
            setupDragSort(card);
        });
        
        // 同时初始化已存在的生成图片的拖拽功能
        const existingImages = document.querySelectorAll('.draggable-generated-image');
        console.log('初始化已存在的生成图片拖拽功能，共', existingImages.length, '个');
        existingImages.forEach(img => {
            const imageUrl = img.getAttribute('data-image-url') || img.src;
            if (imageUrl) {
                setupImageDragToUpload(img, imageUrl);
            }
        });
    }, 500);
}
