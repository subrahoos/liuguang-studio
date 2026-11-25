export interface CloneMethod {
  id: string;
  name: string;
  styleShortName?: string;
  category: string;
  usageMode?: "normal" | "clone" | "both";
  description: string;
  sourceVideoName?: string;
  sourceAnalysisPath?: string;
  sourceTranscript?: string;
  methodSummary?: string;
  videoStructureBreakdown?: string[];
  shotTimeline?: string[];
  voiceoverRules?: string[];
  actionRules?: string[];
  expressionRules?: string[];
  sceneRules?: string[];
  productShowcaseRules?: string[];
  visualStructure: string[];
  assetNeeds: string[];
  directorRules: string[];
  productReplacementRules: string[];
  grokPromptRules?: string[];
  failureReviewRules?: string[];
  qualityRubric?: string[];
  assetRolePolicy?: string[];
  englishMethodSummary?: string;
  englishVisualRules?: string[];
  englishImagePromptRules?: string[];
  englishVideoPromptRules?: string[];
  promptFocus: string;
  source?: string;
  updatedAt: string;
}

const sharedAccountFrameRules = [
  "资产图目标不是精修商品图，而是真实短视频账号里可以继续生成动作的视频关键帧：人物处在动作中、身体有方向、商品有受力、场景有固定锚点，并保留自然构图空间但不直接生成文字。",
  "场景润色来自前景/中景/远景层次、稳定锚点、自然遮挡、真实生活证据和光影节奏；优先按具体方法选择环境细节，不要用空白干净背景替代账号场景。",
  "保留账号拍法、节奏、构图习惯、动作习惯、自然版式空间和栏目感；文字、账号名、水印、价格、状态栏、进度条后期添加，image-2 不直接生成。",
  "资产反推要服务账号拍法：需要段首锚图、人物动作帧、产品结构/上身图、产品细节图、场景光影锚图、转场/侧背面/表情图等类型，但具体数量和时长拆分由调用链路决定。",
];

const sharedFailureRules = [
  "如果生成结果像精修商品写真，说明缺少账号拍法、动作瞬间、真实场景锚点和视频关键帧语义，需要补 mid-motion pose、handheld framing、scene anchor、action arc。",
  "如果结果出现界面元素、状态栏、进度条或乱码文字，说明把后期载体误当生成目标；必须改回无字的视频关键帧，并禁止 text、UI、watermark、status bar、progress bar。",
  "如果视频后续只有慢推镜头，说明资产图没有动作方向，导演稿也没有起始动作、过程、停顿点和衣料受力，需要补完整动作链。",
  "如果商品结构漂移，优先缩小场景复杂度并强化商品结构锁；商品图优先级高于账号风格和方法库描述。",
];

export const sharedCloneQualityRubric = [
  "商品结构准确：当前商品图是唯一商品真相，领口、袖口、下摆、材质、纹理、镂空/刺绣/织法、颜色和版型不能被方法库来源视频改写。",
  "账号方法相似：生成结果要保留所选方法的场景容器、构图习惯、动作语法、节奏、运镜边界和账号模板感，而不是只生成漂亮商品图。",
  "动作真实可拍：每段必须有身体方向变化、手部接触、重心转移、布料受力或表情口型变化，不能只有慢推、眨眼、头发轻晃或静态动图感。",
  "资产可用于视频：资产图必须是可被 Grok/Omni 继续生成动作的视频关键帧，包含场景锚点、人物动作状态、商品可读区域和连续性信息。",
  "分段职责清楚：完整导演稿决定全局，分段计划决定当前段，资产图决定画面结构，商品图决定产品结构；四者不能互相打架。",
  "无后期污染：image-2 和视频模型不直接生成文字、账号名、水印、价格、状态栏、进度条、App UI、logo 或海报排版。",
];

export const sharedCloneAssetRolePolicy = [
  "A1 first_frame_composition_anchor：段首构图锚图，建立方法场景容器、人物位置、完整商品/穿搭和第一帧账号感。",
  "A2 identity_expression_anchor：身份、表情、手机遮脸/口型/眼神/脸部角度锚图，保证人物一致性和本段情绪。",
  "A3 product_on_body_structure_anchor：商品上身/使用状态结构锚图。户外/室内对镜通常是全身或 3/4 身；车内为坐姿 2/3 身或腰上身；广告/杂志按方法构图但必须证明商品轮廓。",
  "A4 product_front_structure_lock：商品正面结构锁，补清领口、袖口、下摆、纹理、图案、边缘、透明度、材质和版型。",
  "A5 product_detail_interaction：手部与商品细节交互图，例如捏领口、轻捏下摆边缘、点按袖口、顺腰线、摸口袋边、展示面料纹理。上衣类商品禁止大幅拉伸或把衣摆拉成布片。",
  "A6 motion_transition_pose：动作过渡姿态。必须表现身体方向、重心、手部路径和布料受力，不能变成普通商品近景。",
  "A7 ending_continuity_anchor：段尾连续性锚图，用于停顿、侧背、回看或下一段衔接，场景、身份、商品和下装保持稳定。",
];

export const defaultCloneMethods: CloneMethod[] = [
  {
    id: "street-cafe-lifestyle",
    name: "街拍/咖啡店轻生活",
    styleShortName: "街拍轻生活",
    category: "街拍",
    usageMode: "both",
    description:
      "适合女装、鞋包、配饰、轻熟风商品。核心是把咖啡店、车边、街边玻璃、坐姿和手部细节拆成可复用账号拍法，而不是只生成漂亮街拍图。",
    sourceVideoName: "手搓视频 / 少返工省 token",
    methodSummary:
      "从 19efe6c66bd_1c7 蒸馏：它本质是博主教学里的“少返工省 token”工作流，先观察参考账号，再沉淀可复用 skill。方法核心不是某个咖啡店画面，而是把主体、场景、服装、动作、镜头、字幕/音乐节奏拆成可复用账号模板；示例里的咖啡店、车边、坐姿、手表、包、杯子和街拍自然光，都是为了让最终图像像真实带货账号正在拍摄的一帧，而不是商品棚拍。",
    videoStructureBreakdown: [
      "证据来源：19efe6c66bd_1c7 细抽帧约 186.67s，2fps 连续帧 373 张、场景变化帧 120 张、分页故事板 15 张；分析时按故事板顺序读取，不只看封面。",
      "结构模板：环境氛围开场 -> 人物自然入画 -> 商品自然上身/入画 -> 手部/腰部/领口/包/杯子细节 -> 全身或半身回看 -> 轻 CTA。",
      "账号模板感：固定街边或咖啡店容器，人物偏侧或半身入画，保留顶部/底部可后期叠字的自然留白，但 image-2 不生成文字。",
      "案例生成效果强调真实内容感：不是棚拍大片，而是像手机或轻相机拍下的生活片段，带轻微动作、手部交互和环境背景。",
      "动作链必须可连续：拿杯子、看手机、扶包带、整理衣摆、转头看街景、坐下再回看商品。",
      "资产包应从账号拍法和完整内容结构反推，不能只给一张漂亮全身图。",
      "保存为方法时必须记录：场景容器、生活锚点、人物进入方式、手部动作习惯、商品细节路径、自然构图空间、可替换商品边界。",
    ],
    shotTimeline: [
      "0-3s：街边/咖啡店环境锚点，人物半身或侧身自然进入，商品不硬广但可见。",
      "3-7s：手部动作带出商品细节，例如扶包、整理衣摆、拿杯子、低头看手机。",
      "7-10s：全身/半身回看，停顿 0.5-1 秒，给后期标题或口播收束。",
      "10s 以后重复“环境 -> 动作 -> 细节 -> 回看”的账号节奏，但动作与构图要换，不复制同一站姿。",
    ],
    voiceoverRules: [
      "口播像轻种草，不要硬喊卖点：先讲生活场景或穿搭痛点，再说商品细节和穿着效果。",
      "字幕节奏可参考原账号信息密度，但文字内容必须替换成自有商品表达。",
    ],
    actionRules: [
      "动作幅度小到中等，重点是动作正在发生：扶包带、拿杯子、整理衣摆、转肩、换坐姿、低头再抬眼。",
      "每段至少一个主体动作和一个商品细节动作，避免只有镜头慢推。",
    ],
    expressionRules: [
      "表情自然克制：低头专注、轻微微笑、抬眼停顿、看窗外，不能夸张大笑或僵硬看镜头。",
      "如果有口播，口型要轻而短，像随口分享穿搭心得。",
    ],
    sceneRules: [
      "咖啡店外摆、玻璃窗、街边树影、路边车辆、行人虚化、桌面杯子和包是场景锚点；这些锚点要像真实账号素材里的生活证据，不是摆拍装饰。",
      "场景要有前景桌面/杯子/手部，中景人物和商品，远景街道/车/橱窗/树影；不要只给空白背景或居中商品照。",
      "光线以自然日光、玻璃反射、树影和轻微街拍曝光为主，保留真实感的小瑕疵，但商品结构不能被阴影吞掉。",
      "场景锚点稳定，但每段可改变机位和人物动作，形成账号连续内容而非随机换景。",
    ],
    productShowcaseRules: [
      "商品先自然出现，再用领口、袖口、腰部、下摆、鞋包、面料纹理验证质感。",
      "服装类必须锁颜色、版型、领口、袖长、下摆、裤型/裙摆、图案和材质。",
    ],
    visualStructure: [
      "开场先给生活化环境，而不是先给白底商品；环境要像真实街拍视频关键帧。",
      "主体镜头从半身/侧脸/坐姿进入，再切全身站姿或坐姿，然后穿插手腕、腰部、领口、杯子、包、鞋面。",
      "人物可偏左或偏右，不必永远居中；可以有桌面边缘、椅背、车门、玻璃窗反射形成自然遮挡和账号构图。",
      "画面气质是轻生活、低攻击性、高真实感：自然坐姿、手部交互、低头看手机、拿杯停顿、回头看街景，而不是直视镜头硬广。",
      "构图要留出自然叠字空间但不能生成文字；留白来自墙面、玻璃、桌面或街景空区，不是硬贴空白底。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "段首锚图：模特在咖啡店或街边自然坐/站，商品完整可见，环境锚点明确。",
      "人物动作帧：拿杯子、扶包带、低头看手机、转头看街景、整理衣摆。",
      "商品结构图：正面、侧面、背面、领口、袖口、腰部、下摆、裤型/裙摆、面料纹理。",
      "场景图：咖啡店外摆、玻璃窗、街边树影、路边车辆或行人虚化。",
      "转场图：半身细节到全身回看的中间姿态，便于视频模型衔接。",
      "故事板索引：保存关键帧顺序说明，例如环境锚点帧、人物入画帧、动作帧、商品细节帧、回看帧，后续 LLM 可按顺序复用。",
    ],
    directorRules: [
      "完整视频按“生活环境 -> 人物动作 -> 商品细节 -> 全身回看 -> 轻 CTA”组织。",
      "先写完整内容结构，再按调用链路需要反推资产；资产要对应具体动作和场景，不允许把同一批图通吃全片。",
      "每个动作必须写清起始姿态、动作过程、停顿点和衣料受力变化。",
      "不要只写 cinematic、premium、beautiful，要写清镜头距离、人物站位、光线方向、手部动作和商品细节验证。",
      "普通项目调用时，把它变成分镜提示词结构；爆款复刻调用时，把它变成完整导演稿和资产反推方法。方法库本身不规定具体分段秒数。",
    ],
    grokPromptRules: [
      "Grok 段落 prompt 要从完整稿对应时间段切片，不重新发明画面。",
      "参考图优先顺序：段首锚图 -> 人物动作帧 -> 商品结构/细节 -> 场景锚图。",
      "明确禁止 only camera push-in；主体动作和商品动作必须是主要运动来源。",
    ],
    productReplacementRules: [
      "保留生活化高级感、街拍节奏和账号栏目感，不复制原人物、原衣服、原品牌、原字幕和原口播。",
      "商品替换时必须硬锁颜色、版型、领口、袖口、腰线、裤型/裙摆、图案和材质。",
      "当前商品图优先级高于方法库风格描述，商品结构不允许被街拍氛围改写。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果画面像普通咖啡店写真，说明缺少账号模板感和动作链；需要补桌面/杯子/包/玻璃/街车锚点以及手部动作。",
      "如果商品被生活道具抢走，减少杯子和包的面积，让手部动作服务商品结构。",
    ],
    englishMethodSummary:
      "Reusable street cafe lifestyle method: create a phone-recorded ecommerce fashion frame inside a real cafe or street container, with natural props, casual hand actions, readable product structure, and account-template rhythm instead of polished catalog photography.",
    englishVisualRules: [
      "Use layered street/cafe composition: foreground table edge, cup, bag, hand, or window frame; midground model wearing the product; background cars, storefront glass, street trees, passersby, or cafe interior depth.",
      "Shot sizes should alternate between half-body lifestyle frames, seated or standing full-body proof, upper-body product proof, and close detail frames for neckline, sleeve, waist, hem, fabric, bag, or shoes.",
      "Camera language should feel like a real creator shooting lifestyle content: handheld micro-jitter, short push-in only when tied to a hand action, slight lateral repositioning, natural crop, and no clean studio symmetry.",
      "Lighting should be natural daylight through glass or street trees, with soft reflections, small exposure imperfections, and product-readable highlights; avoid blank background, glossy beauty lighting, or commercial studio polish.",
    ],
    englishImagePromptRules: [
      "Every image-2 asset prompt must specify scene anchor, foreground/midground/background, shot size, camera angle, product-visible areas, hand contact point, action state, lighting direction, and negative constraints against text, logos, UI, and product redesign.",
      "Assets must look like video keyframes in motion: the model is lifting a cup, adjusting a bag strap, smoothing the hem, turning toward the street, sitting down, or looking back, not posing like a static catalog model.",
      "Keep the user's product structure higher priority than cafe props; props are allowed only when they support hand action, scale, lifestyle credibility, or product proof.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must describe normal real-time movement: hand reaches for cup, shoulder turns, bag strap is adjusted, hem is smoothed, fabric reacts to body motion, then the model pauses for a readable product frame.",
      "Camera movement must support subject action: handheld follow, small push-in tied to the hand detail, short lateral pan revealing cafe/street depth, or locked-off lifestyle frame; forbid only-camera-push-in and cinemagraph-like motion.",
      "Each segment should preserve the same scene container and product identity while changing body direction, hand action, or shot distance to avoid repeated pretty still images.",
    ],
    promptFocus:
      "街拍轻生活、咖啡店/街边容器、真实视频关键帧、动作中的一帧、手部交互、商品细节验证、账号栏目感、资产包反推。",
    source: "19efe6c66bd_1c7.mp4",
    updatedAt: "2026-06-29",
  },
  {
    id: "car-ootd-container",
    name: "汽车/车内 OOTD",
    styleShortName: "车内 OOTD",
    category: "汽车",
    usageMode: "both",
    description:
      "适合同场景多套穿搭、通勤、出门前造型、配饰类商品。核心是固定车内容器和栏目标题感，让人物、动作、服装变化在同一账号模板里发生。",
    sourceVideoName: "车内 OOTD / 首帧 + 文案 + 分镜逻辑",
    methodSummary:
      "从 19efe6ccc9f_a5b 蒸馏：这是车内 OOTD 账号模板，不是普通车内照片。核心是先锁首帧容器：红色内饰、方向盘、安全带、车窗、杯子、包和 Weekly Outfit Ideas 栏目留白，再让人物在同一容器里通过拿杯、扶方向盘、戴墨镜、看窗外、整理衣领等动作展示穿搭。方法要保留“同一个车内容器连续产出多条 look”的账号感。",
    videoStructureBreakdown: [
      "证据来源：19efe6ccc9f_a5b 细抽帧约 180.57s，2fps 连续帧 361 张、场景变化帧 110 张、分页故事板 15 张；核心证据来自红色车内 OOTD 示例、首帧配置、参考图矩阵和提示词执行过程。",
      "结构模板：车内空间建立 -> 坐姿人物亮相 -> 同一机位动作变化 -> 商品/穿搭细节 -> 通勤情绪或 CTA。",
      "账号模板感：固定车内空间、标题留白、驾驶位/副驾位构图、红色或明显内饰色块、杯子/包/墨镜作为固定道具。",
      "画面不是随机换衣，而是同一空间里通过动作和穿搭变化维持栏目连续性。",
      "每段必须有开始状态、动作过程、结束状态：扶方向盘、拿杯子、戴墨镜、转头看窗外、整理衣领或包带。",
      "保存为方法时必须记录：车内容器、首帧锚点、标题留白、坐姿动作链、车窗/方向盘/安全带锚点、穿搭变化边界和道具使用规则。",
    ],
    shotTimeline: [
      "0-2s：首帧建立车内空间，方向盘、座椅、车窗、安全带和标题留白出现。",
      "2-4s：人物做第一个动作，如拿杯子或扶方向盘，同时商品上身可读。",
      "4-7s：切近一点展示领口、腰部、袖口、包或配饰。",
      "7-10s：回到坐姿全身/三分之二身，做轻 CTA 或通勤情绪停顿。",
    ],
    voiceoverRules: [
      "文案要和车内动作绑定：出门、通勤、周一穿搭、车上准备、临出门检查。",
      "口播节奏可短句化，每句对应一个动作或商品细节，不要画面和文案分离。",
    ],
    actionRules: [
      "坐姿动作优先：扶方向盘、拿咖啡、戴墨镜、拨头发、拉衣领、扶安全带、整理包带。",
      "动作要在座椅空间内完成，不能突然下车街拍或随机换场。",
    ],
    expressionRules: [
      "表情偏通勤生活感：看窗外、低头喝咖啡、轻微微笑、对镜/对手机确认穿搭。",
      "如果说话，口型短促自然，像一边出门一边分享。",
    ],
    sceneRules: [
      "方向盘、安全带、座椅、车窗、杯架和车门线条是必须稳定的空间锚点；红色或强色内饰是账号模板感的重要色块。",
      "空间层次要清楚：前景杯子/手/方向盘，中景人物和商品，远景车窗外草地、街景或建筑虚化。",
      "车窗自然光从侧前方进入，内饰有轻微反光和阴影；不要变成棚拍车模图，也不要让车内黑成一团。",
      "车标和品牌标识不要复刻；可用无品牌内饰、模糊街景和自然窗光。",
    ],
    productShowcaseRules: [
      "坐姿下仍要看出服装版型，不能让安全带或手臂遮住关键结构。",
      "服装细节要在车内自然展示，例如领口、腰线、袖口、包带、鞋面或裤型。",
    ],
    visualStructure: [
      "固定车内空间：座椅、方向盘、车窗、安全带、杯架、车门线条是稳定视觉锚点。",
      "人物多为坐姿半身或三分之二身，动作在同一空间里连续变化；腿部、包、杯子和方向盘共同证明她真的坐在车里。",
      "构图可以有方向盘大前景、车窗斜线、安全带斜线和红内饰色块，形成账号识别度。",
      "如果有栏目标题或文字卡，保持信息层级和出现位置，但文字后期添加，image-2 不生成。",
      "画面要像手机/车内固定机位拍摄的穿搭内容，不能变成豪车广告或纯人像写真。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "首帧锚图：车内驾驶/副驾构图，方向盘、安全带、窗外街景和人物坐姿清晰。",
      "人物动作帧：扶方向盘、拿杯子、戴墨镜、看窗外、调整衣领/包带。",
      "商品坐姿结构图：半身、三分之二身、领口、袖口、腰线、包/配饰细节。",
      "场景锚图：车窗、座椅、红色或明显内饰色块、杯架、车门线条。",
      "转场图：从杯子/手部细节回到坐姿整体的中间帧。",
      "故事板索引：保存首帧车内锚图、杯子/方向盘动作、服装细节、换装/栏目延展和结尾口播帧的顺序，后续 LLM 可按顺序生成导演稿。",
    ],
    directorRules: [
      "先锁车内空间和坐姿，再让商品变化，避免模型随机换场景。",
      "完整稿要按车内连续动作写，不能只是把几张车内照片串起来。",
      "资产从完整稿的动作和场景结构反推；至少覆盖空间锚图、动作帧和商品细节。",
      "镜头可轻微推近、侧移或手持微晃，但方向盘、安全带、座椅关系必须稳定。",
      "普通项目调用时可生成车内分镜；爆款复刻调用时要先生成完整车内 OOTD 导演稿，再按目标时长由调用链路决定分段和参考图数量。",
    ],
    grokPromptRules: [
      "强调同一车内容器连续展示，禁止突然走路、户外街拍、换车或换内饰。",
      "参考图优先级：首帧车内锚图优先，然后人物动作、商品细节、场景锚点。",
      "视频动作要正常速度，不能只做慢推或静止换装。",
    ],
    productReplacementRules: [
      "保留车内容器、坐姿 OOTD 结构和栏目感，替换车标、原人物、原服装、原品牌和文案。",
      "商品在坐姿下仍要符合商品图结构，不能因坐姿压缩导致版型消失。",
      "配饰/包/杯子只作为道具，不允许抢走商品主体。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果车内空间不稳定，优先补方向盘、安全带、座椅、车窗、杯架的首帧锚图。",
      "如果视频像静态摆拍，补坐姿动作链：拿杯、扶方向盘、戴墨镜、看窗外、整理衣领，并写清动作起止。",
      "如果商品被安全带或方向盘遮挡，降低道具遮挡并增加商品正面/半身结构资产。",
    ],
    englishMethodSummary:
      "Reusable car OOTD container method: lock a recognizable car interior as the account template, then use seated outfit actions, steering wheel/window/seatbelt anchors, and product-readable styling changes to create a repeatable fashion account format.",
    englishVisualRules: [
      "Keep the car container stable: steering wheel, seat, seatbelt, car window, cup holder, door line, and optional strong interior color must remain spatial anchors across assets and video segments.",
      "Use seated half-body, three-quarter body, and detail shots; legs, hands, bag, cup, steering wheel, and window depth should prove the model is actually inside a car.",
      "Camera angles should feel like phone or small camera placement inside the vehicle: dashboard-level, passenger-seat angle, slight handheld drift, short push-in toward collar/waist/detail, or locked-off seated frame.",
      "Lighting should come through the car window with soft side highlights, mild reflections on interior surfaces, and readable product details; avoid luxury car advertising, random vehicle changes, or dark unreadable interiors.",
    ],
    englishImagePromptRules: [
      "Every image-2 asset prompt must name the car interior anchors, seated pose, shot size, product-visible structures, hand action, window-light direction, and forbidden changes to vehicle, product, identity, text, logos, and UI.",
      "Asset roles should include first-frame car anchor, steering-wheel/cup action, seated product proof, collar/waist/sleeve detail, and return-to-seated full look; do not create unrelated outdoor fashion photos.",
      "Product structure must remain readable despite seatbelt, hands, or steering wheel; reduce prop obstruction when collar, waist, hem, or silhouette is the product proof.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must keep the same car interior while the model performs concrete seated actions: lifting a cup, touching the steering wheel, putting on sunglasses, looking through the window, smoothing the collar, or adjusting a bag strap.",
      "Use normal-speed creator-video motion, not static slideshow: start pose, hand movement, body lean or head turn, fabric response, product-readable pause, then a short ending hold.",
      "Allowed camera movement: locked passenger-seat frame, slight handheld drift, short push-in to product detail, or small lateral reposition inside the cabin. Forbid sudden exterior street walk, car swap, interior redesign, and only slow zoom.",
    ],
    promptFocus:
      "车内容器、红色内饰账号模板、坐姿 OOTD、方向盘安全带、通勤栏目感、首帧锚图、动作段拆解、同空间连续变化、资产包反推。",
    source: "19efe6ccc9f_a5b.mp4",
    updatedAt: "2026-06-29",
  },
  {
    id: "outdoor-mirror-selfie",
    name: "户外对镜自拍",
    styleShortName: "户外对镜",
    category: "对镜拍",
    usageMode: "both",
    description:
      "适合服装账号模板化复用。核心是户外全身镜、手机遮脸、树影、街边车、侧身/回头/整理衣服等动作，形成可批量复用的账号栏目感。",
    sourceVideoName: "户外镜前穿搭 / 账号质感与场景仿制",
    methodSummary:
      "从 19efe6d2cc4_23c 和用户对比图蒸馏：要学习的是账号拍法、节奏和气质，不是界面元素或后期标题层。正确目标是模特穿着当前产品，在外景用手机对着镜面录像时的真实视频关键帧：人物不一定居中，正在侧身、回头、比耶、整理腰部或背身展示；树影、白车、街道、店铺反光玻璃和镜面构成账号模板。",
    videoStructureBreakdown: [
      "证据来源：19efe6d2cc4_23c 细抽帧约 153.23s，2fps 连续帧 306 张、场景变化帧 80 张、分页故事板 13 张；核心证据来自户外镜前夏日穿搭案例、女性服装账号设置、提示词分析和多张户外对镜参考图。",
      "结构模板：户外镜面/街边小店落地窗或玻璃门反射/街景建立 -> 手机遮脸人物入镜 -> 侧身/回头/背身/比耶 -> 服装细节动作 -> 自然构图空间。",
      "账号模板感：全身镜或橱窗反射、树荫、白车、街道、强阳光斑驳、手机遮脸比例和人物偏位是固定语法。",
      "画面应像视频关键帧，不是精修棚拍或商品写真；人物处在动作中，衣服有受力和方向。",
      "标题、字幕、账号名、水印、状态栏、进度条都不由 image-2 生成；只保留自然构图空间。",
      "保存为方法时必须记录：镜面类型、街景锚点、手机遮脸比例、人物偏位构图、动作姿态库、商品结构展示路径和账号标题留白。",
    ],
    shotTimeline: [
      "0-2s：段首锚图，户外镜子和街道树影建立，人物手机遮脸或半遮脸。",
      "2-5s：身体侧转、回头、整理衣摆/腰部/包带，展示上身和腰线。",
      "5-8s：补产品结构细节，领口、袖口、腰封、绑带、裤腰、裤型或裙摆。",
      "8-10s：背身/侧身/全身回看，停顿给下一段衔接或后期信息层。",
    ],
    voiceoverRules: [
      "口播像服装账号教学：这张图/这个 look/这个角度/这个动作为什么出片，再自然带到商品卖点。",
      "字幕密度可强，但内容后期加；提示词只描述留白和构图，不生成文字。",
    ],
    actionRules: [
      "核心动作：走近镜子、侧身、回头、比耶、整理腰封/绑带/裤腰、轻捏或顺平衣摆边缘、扶口袋边缘、背身展示。",
      "动作必须写成可拍摄过程，不写抽象“自然摆动”：脚掌落地或脚尖转向 -> 膝盖/胯部重心转移 -> 肩颈跟随转动 -> 手接触衣摆/领口/袖口/腰部/绑带 -> 布料被拉开后回弹。",
      "每个 8-10 秒片段至少 2-4 个可见动作节点：起始正面或半侧站姿、身体转成三分之二侧身、手部整理商品关键结构、回头/背身/停顿给商品可读画面。",
      "主体动作必须比镜头运动更明显；禁止只有正面站立、慢镜头推进、轻微眨眼、头发飘动或衣服轻晃。",
      "每段至少一个人物姿态变化和一个商品结构动作，商品动作要点名触碰位置，例如轻捏下摆边缘、捏领口、扶袖口、顺腰线、整理绑带或摸口袋边。上衣类商品只做小幅示意，不做大幅拉扯。",
    ],
    expressionRules: [
      "手机可遮挡面部 20%-35%，但脸型、发型、肤色和体态仍绑定身份包。",
      "可有轻笑、抬眼、侧脸回头、低头看手机；不做夸张表情。",
    ],
    sceneRules: [
      "镜面来源可以是户外全身镜、街边小店落地窗、玻璃门、橱窗或高反射墙面；重点是模特用手机对着镜面录像，不生成界面元素、状态栏或后期标题层。",
      "场景必须有三层空间：前景为模特/手机/镜框或玻璃边缘，中景为白车、街沿、橱窗反射或人行道锚点，远景为树冠、树干、建筑立面、窗拱、路人或街道纵深。",
      "白车或路边车是横向场景锚点，通常在人物身后或侧后方，不能贴住身体、压扁背景、遮挡商品或变成大面积车墙。",
      "强太阳光、树影和玻璃反射可以保留，形成街拍光影节奏；但商品不能过曝，领口、袖口、下摆、腰部和面料结构必须看清。",
      "场景要有真实街边生活证据：轻微手持视角、自然路人、街道透视、反射层次、非完美裁切；不要做成干净棚拍、证件照式居中或空白背景。",
      "不要只写“账号质感”或“高级街拍”。必须写清具体画面：镜框或店铺玻璃边缘切入画面、人物偏左/偏右、手机遮脸一部分、人行道地砖透视、树干竖线、白车横线、斑驳硬光落在地面和衣服边缘、背景有店铺/建筑/路人深度。",
      "场景润色要像手机刚录到的爆款服装账号素材：有街边反光、轻微压缩、明暗不均和真实裁切，但不是截图底图、不是 App 界面、不是生成标题文字。",
    ],
    productShowcaseRules: [
      "以全身穿搭为主，补腰部、下摆、裤型/裙摆、鞋型、领口、袖口和面料细节。",
      "服装类必须锁领口、门襟、袖口、腰封、绑带、裤腰、裤型、鞋型等可见结构。",
    ],
    visualStructure: [
      "人物可偏左/偏右，镜框、橱窗边缘或玻璃门边框和街景形成账号栏目容器；不要每张都是正面居中站姿。",
      "资产图要像真实手机对镜录像中的视频关键帧：动作正在发生，手机、手臂、衣摆和身体方向构成运动线索。",
      "同一段内要有连续镜头距离变化：全身建立、中景产品证明、近景手机/脸部遮挡、侧身或背身转向、结尾停顿；这是同一街景/镜面的距离变化，不是换一批无关照片。",
      "如果调用链路生成 7 张资产，至少 4 张必须是全身或膝盖以上中远景的视频关键帧；只允许 1-2 张作为商品近景/细节锁。A3 必须是全身或半全身试穿转身，A6 必须是全身或膝盖以上动作转场，二者都不能变成商品近景。",
      "人物和商品要像短视频账号里抓到的一帧：轻微手持、非完美裁切、真实反射边缘、树影斑驳、街边生活证据和身体正在动；不要生成过度精致的商业写真、产品 lookbook 或干净棚拍图。",
      "每张资产都要有明确镜头职责，不能只写“好看”：A1 负责账号场景建立，A2 负责身份/手机遮脸/表情，A3 负责全身转向和商品上身证明，A4 负责上半身结构，A5 负责具体细节交互，A6 负责动作过渡，A7 负责侧背或结尾停顿。",
      "保留后期叠标题和底部字幕的空间，但绝不生成文字、水印、状态栏或进度条。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "段首锚图：户外全身镜或街边小店反光玻璃、树影、街边车辆、手机遮脸人物和完整商品。",
      "人物动作帧：侧身、回头、背身、比耶、整理腰部、扶裤腰、轻捏或顺平衣摆。",
      "商品结构图：上身全身、腰部/下摆/裤型或裙摆、领口/袖口/面料细节。",
      "场景光影锚图：树荫街景、白车/路边车、镜子边框或橱窗玻璃边缘、地面透视、建筑立面和反射层次。",
      "转场参考：从正面到侧身、从侧身到背身、从细节回全身的中间帧。",
      "7 张资产比例建议：A1 全身开场、A2 中近景身份表情、A3 全身/半全身试穿转身、A4 上半身商品结构、A5 领口/袖口/面料细节、A6 全身/膝盖以上动作转场、A7 全身/半全身侧背结尾；不能让 A3/A4/A5/A6 全部变近景。",
      "故事板索引：保存全身镜建立、手机遮脸、侧身回头、商品细节、背身/结尾停顿的顺序，后续资产反推必须按这个顺序生成可运动关键帧。",
    ],
    directorRules: [
      "完整内容要先写账号拍法，再按调用链路反推资产；资产包要围绕具体动作和服装展示生成。",
      "手机遮挡面部约 20%-35%，镜子/橱窗反射边框、背景车辆、树影、建筑立面和地面透视要稳定。",
      "视频提示词必须写正常短视频速度的动作过程：开始姿态、脚步或脚尖转向、胯肩转动、手触碰商品关键部位、布料受力、回头/看镜、结尾停顿；不能只写“轻微走近”或“自然动作”。",
      "镜头只做辅助：轻微手持跟随、微推或微侧移可以存在，但不能替代人物动作。每段都要让身体方向、手部交互和商品展示成为主要运动来源。",
      "运镜必须点名具体类型和边界，不能只写慢推镜头。户外对镜优先使用：固定镜前构图 + 手持微晃、短距离拉镜显全身、轻微横移保留镜框/白车/树影、固定特写拍领口袖口、或很短的推镜跟随手部整理。环绕运镜只允许 10-30 度小弧度，且不能破坏镜面反射逻辑。",
      "如果 GPT 想写慢推，必须同时写清主体动作，例如“轻微推镜跟随她从正面转到三分之二侧身，左手轻捏下摆黑边 2-4 cm 后松开，衣摆回到原位置停顿”。禁止只有 slow push-in / slow zoom / camera moves closer，也禁止把上衣拉长或拉成布片。",
      "资产反推时必须先分配镜头距离和动作职责，再写商品细节；不要为了商品准确把大多数资产写成上半身近景。A3/A6 是动作连续性资产，不是细节资产。",
      "明确禁止服装变色、腰封消失、绑带消失、裤子变裙子、裤型变紧身、镜子/玻璃反射/街景突变。",
      "方法库只定义户外对镜拍法和资产类型，不定义固定 10 秒资产数量；普通项目走分镜，爆款复刻由目标时长链路决定分段。",
    ],
    grokPromptRules: [
      "参考图优先包含：段首镜前锚图、侧身动作、背身/回头动作、商品细节、场景锚点。",
      "Grok 要按完整稿时间切片生成，而不是让每段重新想一个新 look。",
      "动作要真实生活化，不能全程慢动作，也不能只靠镜头推进。",
      "Grok/Omni 段落 prompt 必须明确：normal real-time short-video motion, not a cinemagraph, not an animated photo, not only camera push-in。随后写 2-4 个具体动作节点和对应商品展示位置。",
      "Grok/Omni 段落 prompt 还必须写 camera movement plan：camera type、start framing、end framing、speed、subject distance、product area kept visible、forbidden camera behavior。图片模型和视频模型不负责思考，所有运镜决策由 LLM 在提示词里写清楚。",
      "参考图是动作和结构锚点，不是幻灯片顺序。视频必须在参考图之间生成身体转向、手部触碰、布料回弹和镜头跟随的过渡。",
    ],
    productReplacementRules: [
      "保留户外镜前自拍构图、账号模板、树影街拍和动作语法，不复制原人物、原服装、原字幕。",
      "商品必须替换成当前上传商品，商品图优先级高于视频参考中的旧衣服。",
      "如果当前商品与参考服装结构差异大，保留拍法和构图，放弃参考旧衣服结构。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果场景像普通街拍而不是对镜录像，补镜框/橱窗玻璃边缘、手机遮脸比例、反射关系和街边固定锚点。",
      "如果画面太居中太干净，补人物偏位、树影斑驳、白车横向锚点、地面透视和非完美手机构图。",
      "如果商品被手机或手臂遮挡，调整手持位置，让手机遮脸但不遮商品领口、腰部、下摆和关键结构。",
      "如果 7 张资产里中近景过多，说明资产职责失衡；必须重写 A3 为全身/半全身试穿转身，重写 A6 为全身/膝盖以上动作过渡，并保留 A1/A7 的全身或半全身账号帧。",
      "如果画面偏精致商业图，降低 commercial/lookbook/studio 语义，改成 raw phone-recorded fashion account frame、imperfect mirror reflection、casual street OOTD capture、slight phone compression。",
      "如果视频像慢动作动图或只让图片活了一点，说明导演稿缺少动作节点；重写为正常速度短视频，补脚步/重心/手部接触/布料受力/回头停顿，并明确禁止 cinemagraph、animated still、only camera push-in。",
    ],
    englishMethodSummary:
      "Outdoor mirror selfie fashion-account method: the target is a phone-recorded mirror or storefront-reflection video keyframe, with partial face cover, street trees, white cars, shop-window reflection, body-direction changes, and product structure locked to the user's product.",
    englishVisualRules: [
      "Use mirror, storefront glass, shop-window reflection, or glass-door reflection as the container; include mirror/glass edge, phone partially covering the face, street depth, trees, parked cars, sidewalk perspective, and imperfect reflection.",
      "Prioritize full-body and knee-up action frames over close-ups: A1 account scene anchor, A2 identity/phone-cover frame, A3 full-body or half-full-body turn, A4 upper-body product proof, A5 detail contact, A6 full-body transition, A7 side/back ending hold.",
      "Camera language: fixed mirror composition with handheld micro-jitter, short pull-back to reveal full body, slight lateral move preserving mirror edge/white car/tree shadow, locked detail shot, or short push-in tied to product adjustment.",
      "Lighting should be direct outdoor daylight with dappled tree shadow, glass reflection, small exposure imperfections, and readable garment structure; avoid commercial lookbook polish, clean studio background, and random street beauty portrait.",
    ],
    englishImagePromptRules: [
      "Every image-2 asset prompt must name the mirror or reflective surface, phone-cover ratio, body direction, hand contact point, product structures visible, street anchors, tree-shadow lighting, shot size, and negative constraints.",
      "The product must match the user's uploaded product exactly; method style may shape pose and scene, but must not borrow the source outfit or redesign neckline, sleeve, hem, waistband, trousers, skirt, trim, pattern, or fabric.",
      "Assets should be video keyframes: the model is turning, stepping closer, looking back, adjusting waist/hem/collar/sleeve, holding pocket edge, or pausing after a body-direction change.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must explicitly say normal real-time short-video motion, not a cinemagraph or animated still, and include 2-4 action nodes: start pose, foot/hip/shoulder turn, hand touches product detail, fabric reacts, then readable pause.",
      "Camera movement must be described as a plan: camera type, start framing, end framing, speed, product area kept visible, and forbidden behavior. Avoid only slow push-in, slow zoom, random orbit, or breaking mirror/reflection logic.",
      "Reference images are structure/action anchors, not slideshow frames; the video must interpolate body turns, hand contact, fabric rebound, and slight handheld mirror-recording motion while preserving product and identity.",
    ],
    promptFocus:
      "户外镜面或街边店铺反光玻璃、手机遮脸录像、账号模板感、树影白车街拍、动作中的视频关键帧、侧身回头背身、服装结构硬锁、资产包反推。",
    source: "19efe6d2cc4_23c.mp4",
    updatedAt: "2026-06-29",
  },
  {
    id: "home-mirror-fashion",
    name: "居家/室内对镜带货",
    styleShortName: "室内对镜",
    category: "居家",
    usageMode: "both",
    description:
      "适合服装带货主链路。核心是先生成模特、服装分解图、场景服务图，再写脚本/导演稿；不是先空写视频。",
    sourceVideoName: "服装带货视频 / 模特、分解图、脚本四件套",
    methodSummary:
      "从 19efe6db3d8_7d6 蒸馏：这是服装带货的“一个 skill”生产链路，重点不是只做室内对镜成片，而是把商品图、模特图、场景服务图、5 分镜图片和脚本串成可复用方法。正确顺序是商品/人物识别 -> 服装分解图和多视图 -> 室内镜前/门边/浅色房间场景 -> 分镜图片 -> 脚本/导演稿 -> 视频。画面要像真实穿搭账号在家试衣，而不是棚拍商品照。",
    videoStructureBreakdown: [
      "证据来源：19efe6db3d8_7d6 细抽帧约 141.90s，2fps 连续帧 284 张、场景变化帧 88 张、分页故事板 12 张；核心证据来自“一个 skill”、商品图/模特图、5 分镜图片生成、室内对镜成片和案例页面展示。",
      "结构模板：室内镜前环境建立 -> 正面全身展示 -> 侧身/背面/走近镜子 -> 服装细节 -> 口播或轻 CTA。",
      "生产模板：先确认主模特身份和商品结构，再生成室内镜前首帧、侧背面、细节、手部动作和场景服务图。",
      "动作节奏必须有可见变化，不能只慢慢推进或静止站立。",
      "账号气质是低成本真实穿搭分享，不是棚拍大片，也不是纯商品海报。",
      "保存为方法时必须记录：商品图如何变成分解图、模特图如何绑定身份、室内镜前首帧如何生成、分镜图片如何服务后续视频和脚本。",
    ],
    shotTimeline: [
      "0-2s：室内全身镜、白墙/浅木地板/自然光建立，人物正面全身。",
      "2-5s：侧身或走近镜子，整理衣服、扶腰、插袋或拿包。",
      "5-8s：领口、袖口、腰部、下摆、裤型/裙摆、面料细节。",
      "8-10s：回到全身或半身口播，停顿收束。",
    ],
    voiceoverRules: [
      "口播围绕试穿感受、适合场景、版型和细节，像在家里真实试衣分享。",
      "如果是多套 look，要让每段口播对应一个动作或一个服装细节。",
    ],
    actionRules: [
      "动作包括正面站立、侧身、背面、走近镜子、整理衣服、扶腰、插袋、拿包或杯子。",
      "每段要有中等幅度动作，不允许只站着等镜头推进。",
    ],
    expressionRules: [
      "表情与口播匹配：轻微微笑、认真看镜子、低头确认细节、抬头停顿。",
      "身份包优先，表情不能改变脸型和年龄感。",
    ],
    sceneRules: [
      "白墙、浅木地板、室内全身镜、门框、衣柜边、床边或窗边自然光构成低成本真实感。",
      "场景层次要像家里真实试衣：前景手机/镜框/手部，中景人物和商品，远景门、墙面、地板、衣架或床。",
      "光线更柔、更平、更生活化，不要强油光和棚拍轮廓光；允许自然阴影，但商品细节不能糊。",
      "背景保持干净，允许衣架、床、门、包、杯子等少量生活道具，不能变成杂乱出租屋或空白棚拍。",
    ],
    productShowcaseRules: [
      "全身结构优先，穿插领口、袖口、腰部、下摆、裤型、鞋包和面料细节。",
      "服装结构必须由商品图反推，不能由身份包衣服或旧参考视频衣服决定。",
    ],
    visualStructure: [
      "室内镜前真实感比棚拍高级感更重要；人物动作和商品结构要清楚。",
      "资产包需要首帧、动作帧、服装结构、细节和场景图，不只是普通分镜图。",
      "构图要覆盖正面全身、侧身、背面/侧背、走近镜子、上半身口播、手部整理衣服和产品细节。",
      "画面气质是日常试穿账号：轻微不完美、真实镜面距离、自然站姿、地板透视和生活道具，而不是模特棚拍。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "主模特身份图全套：正脸、五视角、俯仰角、表情口型、全身比例。",
      "服装正面结构图、上身图、侧面、背面、平铺、细节图。",
      "室内镜前场景、全身首帧、半身口播、手部整理衣服动作。",
      "资产类型：段首锚图、侧身/背身动作、商品细节、场景稳定图、转场图。",
      "故事板索引：保存商品图选择、场景服务图、室内对镜首帧、分镜图片和成片示例的顺序，后续 LLM 用它判断资产缺口。",
    ],
    directorRules: [
      "生成顺序应是：人物/商品识别 -> 资产缺口 -> image-2 补资产 -> 完整导演稿 -> 分段视频。",
      "视频动作要中等幅度，包含转身、插袋、整理腰部、扶裤腰、展示下摆或裤型。",
      "导演稿必须把服装结构写准，避免视频模型重新设计衣服。",
      "参考图只服务当前动作和场景真正需要的内容。",
      "普通项目调用时生成室内试穿分镜；爆款复刻调用时先生成完整试穿导演稿，再反推资产包。方法库不把固定镜头数写死。",
    ],
    grokPromptRules: [
      "Grok 段落 prompt 必须以室内镜前首帧为视觉锚点，再描述自然动作。",
      "如果内容较长，必须让不同部分承担不同动作和商品展示职责，避免重复同一资产。",
      "强调真实试穿动作和服装受力，避免全程静止或只走路。",
    ],
    productReplacementRules: [
      "保留室内镜前真实感和走动展示方式，商品结构完全由当前商品图决定。",
      "禁止把裤子变裙子、短上衣变长款、腰封/绑带/门襟/图案消失。",
      "身份包只决定人物脸和身材，不继承身份包原服装。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果画面像棚拍或白底商品图，补室内镜框、地板透视、门/墙/窗光和生活道具。",
      "如果人物只站着不动，补走近镜子、侧身、转背、插袋、整理腰部和停顿看镜动作。",
      "如果商品结构不准，先补服装正面结构图、侧背面图和平铺/细节图，再生成视频资产。",
    ],
    englishMethodSummary:
      "Indoor mirror try-on method: build a realistic home fitting-room account flow from product recognition, identity lock, garment structure breakdown, indoor mirror anchors, try-on action frames, and then full-video directing.",
    englishVisualRules: [
      "Use a real home mirror container: full-length mirror, white or cream wall, light wood floor, door frame, wardrobe edge, bed edge, window light, and a few believable lifestyle props without clutter.",
      "Shot coverage must include front full-body, side turn, side/back view, walking closer to mirror, upper-body speaking frame, hand adjusting garment, and product detail proof.",
      "Camera angle should feel like phone mirror try-on: chest to eye-level mirror angle, slight handheld wobble, natural floor perspective, clean but lived-in background, and product-readable framing.",
      "Lighting should be soft, flat, diffused home daylight; avoid hard beauty shine, oily face highlights, strong studio rim light, or over-clean catalog background.",
    ],
    englishImagePromptRules: [
      "Every image-2 prompt must specify indoor mirror anchor, floor/wall/door/window props, shot size, body direction, hand contact point, visible garment structures, product-consistency lock, and no text/logo/UI.",
      "Assets should be generated from the current product image: product front structure, side/back structure, flat/detail proof, on-body full view, and hand-adjustment keyframes.",
      "Do not inherit clothing from identity-pack images; identity controls face/body only, while the uploaded product controls garment shape, color, trim, neckline, sleeve, hem, waist, trousers, skirt, and material.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must contain natural try-on motion: step toward mirror, turn side, insert hand into pocket, smooth waist or hem, adjust sleeve/collar, show side/back, and pause for a product-readable full-body frame.",
      "Use normal-speed home try-on action, not slow-motion stillness; each segment needs start pose, movement path, hand-product contact, fabric response, and ending hold.",
      "Allowed camera movement: mostly locked mirror frame, slight handheld mirror shake, small push-in tied to hand detail, or short pull-back to full body. Forbid random room changes and product redesign.",
    ],
    promptFocus:
      "室内对镜、一个 skill 生产链路、模特+分解图+场景图+脚本四件套、身份包绑定、服装结构硬锁、真实试穿动作、资产反推。",
    source: "19efe6db3d8_7d6.mp4",
    updatedAt: "2026-06-29",
  },
  {
    id: "sports-brand-ad",
    name: "品牌广告/运动棚拍",
    styleShortName: "运动广告",
    category: "品牌广告",
    usageMode: "both",
    description:
      "适合运动服、功能服、品牌感商品。核心是把框架、主视觉、光线、细节镜头和包装 skill 拆开复用，而不是复制原品牌视觉。",
    sourceVideoName: "运动/品牌广告 / 细节镜头和包装 skill",
    methodSummary:
      "从 19efe6d720f_fa1 蒸馏：这是运动/品牌广告包装方法。博主强调先搭框架，再处理光线、人物一致性、产品细节和品牌主视觉。参考案例里有运动模特、棚拍/健身房光线、手部袖口细节、FLOWER AIGC 式版式和 AI 生成视频讲解。要学的是广告镜头语言、主视觉框架、光线结构和细节镜头，不继承原 logo、品牌、模特或固定服装。",
    videoStructureBreakdown: [
      "证据来源：19efe6d720f_fa1 细抽帧约 213.07s，2fps 连续帧 426 张、场景变化帧 139 张、分页故事板 18 张；核心证据来自运动模特主视觉、框架图、光线图、AI 生成视频讲解和服装细节广告案例。",
      "结构模板：强开场主视觉 -> 人物姿态定格 -> 功能/材质细节 -> 全身回看 -> 品牌感收尾。",
      "画面重点：棚拍背景、强对比光影、正面凝视、运动姿态、拉链/袖口/手部/面料近景。",
      "案例生成效果强调主视觉和细节镜头可复用成一套 skill，而非只产出一条视频。",
      "品牌包装只保留镜头语言和构图，不复制原 logo、原商标和原海报字样。",
      "保存为方法时必须记录：广告框架、主视觉姿态、光线结构、动作力量感、细节镜头顺序、品牌替换边界和封面/电商图延展方式。",
    ],
    shotTimeline: [
      "0-2s：强主视觉开场，人物正面/半身或全身运动姿态。",
      "2-5s：动作帧，抬手、转肩、拉拉链、整理袖口或迈步停顿。",
      "5-8s：产品细节，拉链、袖口、腰部、手部、面料纹理。",
      "8-10s：全身回看或品牌感收尾，画面干净可后期叠字。",
    ],
    voiceoverRules: [
      "口播更像广告片或功能说明：一句场景需求，一句功能/材质，一句穿着结果。",
      "不要虚构功能性强 claims，除非商品信息明确给出。",
    ],
    actionRules: [
      "动作更有力量但不夸张：抬手、转肩、拉拉链、整理袖口、迈步、停顿凝视。",
      "动作要展示材质和结构，不能只做健身摆拍。",
    ],
    expressionRules: [
      "表情偏自信、专注、干净，不做强美妆棚拍或油光皮肤。",
      "如果有口型，短句即可，重点仍是动作和商品结构。",
    ],
    sceneRules: [
      "棚拍、健身房、纯色背景、广告主视觉背景都可以，但品牌标识必须替换或留空。",
      "场景要有广告框架：干净背景、明确光源、人物轮廓、产品细节近景、可后期放标题的版式空间。",
      "灯光要有方向和轮廓：侧逆光、顶光、健身房硬光或棚拍柔硬结合；但避免塑料皮肤、强油光和过度美妆质感。",
      "背景服务产品功能和身体动作，不要随机加奢华道具、文字 logo 或不相关运动器材。",
    ],
    productShowcaseRules: [
      "拉链、袖口、腰部、帽绳、面料、弹性、手部交互是核心展示点。",
      "服装结构不能为了广告感被简化或换款。",
    ],
    visualStructure: [
      "强对比棚拍、正面凝视、全身运动姿态、服装细节穿插。",
      "细节镜头包括拉链、袖口、腰部、手部、面料纹理和身体姿态。",
      "画面气质是品牌广告包装：干净、力量感、结构清楚、光线有设计，但产品和人体动作必须真实。",
      "可同时服务视频、封面图、电商详情图和品牌主视觉；同一资产包需要主视觉、动作帧、细节图和收尾版式。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "广告主视觉：无品牌棚拍背景、模特正面凝视、全身运动姿态。",
      "人物动作帧：抬手、转肩、拉拉链、整理袖口、迈步停顿。",
      "商品细节：拉链、袖口、腰部、手部交互、面料纹理。",
      "背景板和封面构图：留白给后期自有标题，不生成原品牌字样。",
      "资产类型：主视觉锚图、动作帧、细节近景、全身回看、转场图。",
      "故事板索引：保存主视觉、框架示意、光线示意、人物动作、手部/袖口/面料细节和广告收尾的顺序，后续模型按顺序复用。",
    ],
    directorRules: [
      "导演稿要有广告片节奏：强开场、主视觉定格、细节验证、全身回看、品牌感收尾。",
      "先写完整广告导演稿，再按调用链路反推主视觉/动作/细节资产。",
      "运镜可以更硬朗，但仍要避免只有推拉，没有主体动作。",
      "灯光要写清方向、硬度、阴影、反光控制，避免塑料皮肤和油光。",
      "普通项目可用此方法生成运动广告分镜；爆款复刻可用此方法生成完整广告导演稿和资产计划。方法本身不携带原品牌或固定 logo。",
    ],
    grokPromptRules: [
      "Grok prompt 要把参考图作为主视觉和细节依据，而不是让模型重画运动广告。",
      "每段必须包含主体动作和商品细节验证，禁止只做海报式慢推。",
      "如果有后期标题，描述留白，不让模型生成文字。",
    ],
    productReplacementRules: [
      "保留广告镜头语言，不复制原品牌 logo、商标、价格、海报字样。",
      "商品结构、颜色和功能点以当前商品为准。",
      "如果用户没有自有品牌元素，画面应保持干净无品牌。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果结果像普通运动写真，补广告框架、主视觉版式、光线方向和产品细节镜头。",
      "如果出现原品牌/文字/logo，说明替换边界没写清，必须改为无品牌或自有品牌后期添加。",
      "如果只有姿势没有产品证明，补拉链、袖口、腰部、面料、手部交互和功能验证资产。",
    ],
    englishMethodSummary:
      "Sports brand-ad method: preserve the advertising camera language, strong hero visual, controlled light design, functional movement, and product-detail proof while replacing the source brand, model, logo, and outfit with the user's product.",
    englishVisualRules: [
      "Use a clean athletic or studio-ad container: strong hero pose, designed background, clear product silhouette, directional light, contour shadow, product-detail insert frames, and structured brand-ad pacing.",
      "Shot sizes should include hero full-body or half-body, medium action frame, detail close-up for zipper/sleeve/waist/fabric, and a final product-readable hero hold.",
      "Camera movement may be sharper than lifestyle methods: locked hero frame, controlled push-in, low-angle rise, short lateral slide, or detail rack focus, but every movement must protect product readability.",
      "Lighting must be specific: side key light, controlled top light, soft-hard mix, rim on body edge, visible fabric texture, no oily skin, no plastic beauty lighting, no random logo or poster text.",
    ],
    englishImagePromptRules: [
      "Every image-2 asset prompt must specify hero composition, lighting direction, shot size, athletic pose, product structure, detail proof area, background cleanliness, and negative constraints against source brand/logo/text.",
      "Assets must include hero visual, action pose, zipper/sleeve/waist/fabric detail, hand-product interaction, and final clean brand-frame space without generating actual typography.",
      "Do not let brand-ad polish simplify or redesign the product; the uploaded product image remains the hard lock for color, fabric, trims, fasteners, neckline, sleeve, hem, and silhouette.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must combine ad rhythm with real body motion: raise arm, turn shoulder, pull zipper, adjust sleeve, step forward, pause in hero frame, then cut or hold for detail proof.",
      "Camera plan must be concrete: low-angle rise, controlled push-in to product detail, lateral slide across fabric texture, locked hero frame, or rack focus; forbid poster-like static slow push with no body action.",
      "Each segment needs functional product proof, not only fitness posing. Keep background, lighting, identity, and product structure stable while allowing dynamic athletic movement.",
    ],
    promptFocus:
      "运动品牌广告、主视觉框架、强光影、细节镜头、无品牌替换、功能材质验证、FLOWER AIGC 式版式参考但不复制文字、主视觉+细节资产包。",
    source: "19efe6d720f_fa1.mp4",
    updatedAt: "2026-06-29",
  },
  {
    id: "magazine-emotional-film",
    name: "杂志情绪/自然光广告",
    styleShortName: "杂志情绪",
    category: "杂志情绪",
    usageMode: "both",
    description:
      "适合连衣裙、氛围感服饰、香氛、配饰。核心是把自然光、情绪、静物、音乐感和图文版式拆成知识库方法，而不是只写电影感。",
    sourceVideoName: "杂志照片 / 情绪氛围、画面音乐、细节图",
    methodSummary:
      "从 19efe6de370_fc3 蒸馏：这是自然光杂志情绪片工作流。博主先用天空树叶空镜、白裙草地人像、提示词计划、知识库沟通分析和杂志版式案例搭出氛围，再把画面、音乐、卡点、商品和图文版式串起来。方法核心不是泛泛“电影感”，而是自然光、空气感、情绪人像、静物细节、图文留白和慢节奏微动作的组合。",
    videoStructureBreakdown: [
      "证据来源：19efe6de370_fc3 细抽帧约 187.97s，2fps 连续帧 376 张、场景变化帧 104 张、分页故事板 16 张；核心证据来自天空树叶空镜、自然光白裙杂志图、提示词计划、知识库沟通分析和图文版式案例。",
      "结构模板：自然光/空镜铺氛围 -> 情绪人像入场 -> 静物/手部/布料细节 -> 情绪停顿 -> 轻旁白或字幕收尾。",
      "画面重点：天空、树叶、白裙、自然光、绿植、木桌、静物道具、门窗、风和布料动态。",
      "节奏可以慢，但不能空；每个慢动作都要承担情绪、商品或转场功能。",
      "案例生成效果像杂志视频中的一帧，不是普通商品模特图；要有光、空气感、停顿和微动作。",
      "保存为方法时必须记录：空镜/人像/静物/商品细节的顺序、情绪曲线、音乐卡点、图文版式留白、自然光方向和慢节奏微动作。",
    ],
    shotTimeline: [
      "0-2s：自然光空镜或人物局部，建立季节、光线和情绪。",
      "2-5s：人物低头、抬眼、转身、靠门或坐在自然光里。",
      "5-8s：手部、袖口、裙摆、刺绣/图案、面料纹理和风吹布料。",
      "8-10s：情绪停顿或静物收尾，给旁白/字幕空间。",
    ],
    voiceoverRules: [
      "口播可短而诗性，但不能丢销售信息；像旁白或字幕，不像大促叫卖。",
      "音乐感和停顿要写进导演稿，口播句子要能对应画面卡点。",
    ],
    actionRules: [
      "动作密度低但必须有：低头、抬眼、轻笑、沉思、靠门、转身、拿物、布料被风带动。",
      "慢动作要有目的，不能空镜堆砌。",
    ],
    expressionRules: [
      "表情克制：低头、抬眼、轻笑、沉思、停顿，避免广告式夸张兴奋。",
      "眼神和口型要服务情绪，不改变身份。",
    ],
    sceneRules: [
      "自然光、树叶、天空、绿植、草地、木桌、门窗、静物组成氛围锚点。",
      "场景层次要有空气感：前景叶片/光斑/静物，中景人物和商品，远景天空、草地、窗外或墙面。",
      "光线以柔和自然日光、逆光、树叶漏光和轻微胶片颗粒为主；不要变成空洞棚拍或过度广告大片。",
      "静物不能复制原画面版权元素，可替换成自有/通用道具；静物只服务情绪和商品气质。",
    ],
    productShowcaseRules: [
      "商品藏在情绪片中，但袖口、裙摆、刺绣/图案、面料纹理和风吹动态仍要清楚。",
      "如果商品是服装，必须让布料动态符合重力和风向。",
    ],
    visualStructure: [
      "自然光、户外绿植、天空、木桌、静物、低头抬眼、靠门和布料特写。",
      "空镜、静物、脸部、袖口、裙摆、风吹布料共同组成节奏。",
      "画面可以慢，但不能空；每个慢镜头都要承担情绪、商品、转场或音乐卡点功能。",
      "杂志版式感来自画面层次、留白、色调统一和图文后期空间，不让 image-2 直接生成标题或杂志文字。",
      "要让商品在情绪片里被看清，尤其是面料、袖口、裙摆、图案和穿着轮廓。",
      ...sharedAccountFrameRules,
    ],
    assetNeeds: [
      "氛围图：自然光、天空、树叶、绿植、窗边、木桌或门窗。",
      "人物情绪图：低头、抬眼、侧脸、轻笑、沉思、转身停顿。",
      "商品细节：袖口、裙摆、刺绣/图案、面料纹理、手部交互、风吹动态。",
      "静物和转场图：可替换的通用道具、环境空镜、封面构图。",
      "资产类型：氛围锚图、情绪人像、商品细节、布料动态、静物/转场。",
      "故事板索引：保存天空树叶空镜、自然光人物、提示词计划、知识库分析、杂志版式和最终封面感画面的顺序，后续模型用来拆情绪节奏。",
    ],
    directorRules: [
      "完整稿必须写情绪变化：低头、抬眼、停顿、转身、布料被风带动。",
      "不能只写 cinematic，要写光线方向、色温、动作速度、音乐感节奏和停顿位置。",
      "先写完整情绪片，再按调用链路反推氛围图、人像、细节、转场资产。",
      "商品展示要藏在情绪片里，但关键结构仍要看清。",
      "普通项目调用时可变成杂志分镜；爆款复刻调用时先生成完整情绪导演稿，再反推出氛围、人像、细节和转场资产。",
    ],
    grokPromptRules: [
      "Grok prompt 要包含音乐感、光线变化、微动作和布料物理，不只写 reference image。",
      "参考图优先氛围锚图、情绪人像、商品细节、布料动态。",
      "慢节奏也要有动作过程和停顿点，避免生成静态幻灯片。",
    ],
    productReplacementRules: [
      "保留自然光杂志片氛围和慢节奏，替换人物、商品、图案和品牌元素。",
      "避免照搬原画面静物版权内容；静物只保留功能和气质。",
      "商品图决定真实结构，情绪氛围不能改变商品外观。",
    ],
    failureReviewRules: [
      ...sharedFailureRules,
      "如果结果只是漂亮人像，补空镜、静物、图文留白、音乐卡点和商品细节镜头。",
      "如果慢节奏变成静态幻灯片，补低头、抬眼、转身、拿物、风吹布料和停顿点。",
      "如果商品被氛围淹没，增加袖口、裙摆、面料、图案和穿着轮廓的细节资产。",
    ],
    englishMethodSummary:
      "Magazine emotional natural-light method: create a slow but purposeful fashion film built from atmosphere shots, emotional portrait frames, still-life anchors, fabric movement, music-beat pauses, and product-readable detail proof.",
    englishVisualRules: [
      "Use layered natural-light atmosphere: foreground leaves, light spots, flowers, table objects, curtain, or grass; midground model wearing the product; background sky, window, garden, wall, or soft outdoor depth.",
      "Shot sizes should move between atmosphere/empty frame, emotional portrait, medium garment proof, hand/fabric detail, and final quiet hold; every slow shot must carry mood, product, transition, or audio function.",
      "Camera language should be soft and deliberate: locked poetic frame, slow but motivated push-in, small pan following fabric or hand, gentle rack focus, or wind-driven cloth reveal.",
      "Lighting should be natural, airy, and textured: backlight, leaf-filtered sun, soft window light, volumetric dust, subtle film grain, and readable garment surface; avoid empty studio beauty images.",
    ],
    englishImagePromptRules: [
      "Every image-2 prompt must specify atmosphere anchor, natural-light direction, color temperature, foreground/midground/background depth, pose or micro-action, fabric motion, product-visible structures, and negative constraints.",
      "Assets must include atmosphere anchor, emotional portrait, hand/fabric detail, product structure proof, still-life or transition frame, and ending hold; do not generate magazine text, logo, or copied source props.",
      "The image should feel like a frame from a quiet fashion film, not a static portrait: wind moves fabric, hand touches sleeve or skirt, head lowers or eyes lift, and product texture remains readable.",
    ],
    englishVideoPromptRules: [
      "Grok/Omni prompts must describe slow but non-empty motion: head lowers, eyes lift, hand touches fabric, dress or sleeve moves with wind, body turns slightly, object is picked up, then a timed emotional pause.",
      "Camera movement must be motivated by music or emotion: gentle push-in toward face/product, small pan following fabric, rack focus from foreground leaf to garment, or locked frame with fabric motion. Forbid static slideshow and vague cinematic beauty.",
      "Each segment must preserve product identity while using atmosphere, micro-expression, fabric physics, and audio-beat timing to create magazine emotional pacing.",
    ],
    promptFocus:
      "自然光杂志片、天空树叶空镜、情绪人像、静物氛围、知识库沟通分析、音乐感、图文版式留白、布料风动、微动作链、商品结构清晰、资产反推。",
    source: "19efe6de370_fc3.mp4",
    updatedAt: "2026-06-29",
  },
];

export function buildMethodInstruction(method: CloneMethod | null) {
  if (!method) return "";
  const qualityRubric = method.qualityRubric?.length ? method.qualityRubric : sharedCloneQualityRubric;
  const assetRolePolicy = method.assetRolePolicy?.length ? method.assetRolePolicy : sharedCloneAssetRolePolicy;
  const optionalSections = [
    method.methodSummary ? `方法总述：${method.methodSummary}` : "",
  ].filter(Boolean);

  return [
    `【方法库脚本风格：${method.styleShortName || method.name}】`,
    `方法名称：${method.name}`,
    `分类：${method.category}`,
    `适用模式：${method.usageMode || "both"}`,
    `说明：${method.description}`,
    ...optionalSections,
    "",
    "一、来源视频结构拆解",
    ...(method.videoStructureBreakdown || []).map((item) => `- ${item}`),
    "",
    "二、镜头时间轴与结构",
    ...(method.shotTimeline || []).map((item) => `- ${item}`),
    ...method.visualStructure.map((item) => `- ${item}`),
    "",
    "三、口播、动作、表情与场景规则",
    ...(method.voiceoverRules || []).map((item) => `- 口播/音频：${item}`),
    ...(method.actionRules || []).map((item) => `- 动作：${item}`),
    ...(method.expressionRules || []).map((item) => `- 表情/口型：${item}`),
    ...(method.sceneRules || []).map((item) => `- 场景：${item}`),
    ...(method.productShowcaseRules || []).map((item) => `- 产品展示：${item}`),
    "",
    "四、资产反推清单",
    ...method.assetNeeds.map((item) => `- ${item}`),
    "",
    "五、完整视频导演稿规则",
    ...method.directorRules.map((item) => `- ${item}`),
    ...(method.grokPromptRules || []).map((item) => `- Grok：${item}`),
    "",
    "六、商品替换边界",
    ...method.productReplacementRules.map((item) => `- ${item}`),
    "",
    "七、失败复盘规则",
    ...(method.failureReviewRules || []).map((item) => `- ${item}`),
    "",
    "八、质量验收标准",
    ...qualityRubric.map((item) => `- ${item}`),
    "",
    "九、资产角色规则",
    ...assetRolePolicy.map((item) => `- ${item}`),
    "",
    "十、英文模型调用规则",
    method.englishMethodSummary ? `English method summary: ${method.englishMethodSummary}` : "",
    ...(method.englishVisualRules || []).map((item) => `- English visual rule: ${item}`),
    ...(method.englishImagePromptRules || []).map((item) => `- image-2 English rule: ${item}`),
    ...(method.englishVideoPromptRules || []).map((item) => `- Grok/Omni English rule: ${item}`),
    "",
    `十一、提示词重点：${method.promptFocus}`,
    "",
    "执行要求：先识别当前产品包和人物身份包，再按本方法提取拍法、节奏、脚本结构、口播节奏、动作习惯、账号气质和资产类型建议；具体镜头数量、资产数量、时长拆分由调用链路决定。不得覆盖当前产品包的商品外观，也不得继承来源视频里的原商品、原人物、原品牌、原字幕、原价格和版权元素。",
  ].filter(Boolean).join("\n");
}

function takeItems(items: string[] | undefined, max: number) {
  return (items ?? []).filter(Boolean).slice(0, max);
}

function compactText(value: string | undefined, maxChars: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function compactItems(items: string[] | undefined, maxItems: number, maxChars: number) {
  return takeItems(items, maxItems).map((item) => compactText(item, maxChars));
}

export function buildCompactMethodInstruction(method: CloneMethod | null) {
  if (!method) return "";
  const qualityRubric = method.qualityRubric?.length ? method.qualityRubric : sharedCloneQualityRubric;

  return [
    `Method style: ${method.styleShortName || method.name}`,
    `Name: ${method.name}`,
    `Category: ${method.category}`,
    `Mode: ${method.usageMode || "both"}`,
    `Description: ${compactText(method.description, 220)}`,
    method.methodSummary ? `Method summary: ${compactText(method.methodSummary, 650)}` : "",
    method.englishMethodSummary ? `English method summary: ${compactText(method.englishMethodSummary, 420)}` : "",
    `Prompt focus: ${compactText(method.promptFocus, 260)}`,
    "",
    "Core structure evidence:",
    ...compactItems(method.videoStructureBreakdown, 3, 220).map((item) => `- ${item}`),
    ...compactItems(method.shotTimeline, 3, 180).map((item) => `- ${item}`),
    "",
    "Visual / scene grammar:",
    ...compactItems(method.visualStructure, 3, 220).map((item) => `- ${item}`),
    ...compactItems(method.sceneRules, 3, 220).map((item) => `- Scene: ${item}`),
    ...compactItems(method.englishVisualRules, 3, 220).map((item) => `- EN visual: ${item}`),
    "",
    "Action, expression, voiceover:",
    ...compactItems(method.actionRules, 3, 200).map((item) => `- Action: ${item}`),
    ...compactItems(method.expressionRules, 2, 180).map((item) => `- Expression: ${item}`),
    ...compactItems(method.voiceoverRules, 2, 180).map((item) => `- Voiceover: ${item}`),
    "",
    "Product showcase and replacement boundaries:",
    ...compactItems(method.productShowcaseRules, 3, 200).map((item) => `- Product: ${item}`),
    ...compactItems(method.productReplacementRules, 3, 200).map((item) => `- Boundary: ${item}`),
    "",
    "Asset reverse-planning needs:",
    ...compactItems(method.assetNeeds, 5, 210).map((item) => `- ${item}`),
    ...compactItems(method.englishImagePromptRules, 3, 220).map((item) => `- image-2: ${item}`),
    "",
    "Video director / provider rules:",
    ...compactItems(method.directorRules, 4, 220).map((item) => `- Director: ${item}`),
    ...compactItems(method.grokPromptRules, 3, 200).map((item) => `- Grok/Omni: ${item}`),
    ...compactItems(method.englishVideoPromptRules, 3, 220).map((item) => `- EN video: ${item}`),
    "",
    "Failure review and quality gates:",
    ...compactItems(method.failureReviewRules, 3, 180).map((item) => `- Failure: ${item}`),
    ...compactItems(qualityRubric, 5, 180).map((item) => `- Quality: ${item}`),
    "",
    "Execution rule: use this method for shooting grammar, rhythm, scene anchors, motion habits, account-template feel, and asset type suggestions only. Duration split and exact asset count are controlled by the clone workflow. Product images and identity pack always override source-video clothing, person, brand, text, price, logo, and copyrighted elements.",
  ].filter(Boolean).join("\n");
}
