export type QuestionType = "单选题" | "多选题" | "填空题" | "判断题" | "解答题";
export type Difficulty = "基础" | "中等" | "提高";
export type QuestionProvenance = "真题" | "风格题" | "来源待核实";
export type LibraryScope = "public" | "mine";
export type ImageLayout = "right" | "below" | "below-right";
export type DiagramKind = "geometry" | "coordinate" | "function" | "unsupported";
export type DiagramSource = "extracted" | "geogebra-ai" | "svg-ai" | "manual";
export type DiagramCapture = "digital" | "scan" | "photo";
export type DiagramRotation = 0 | 90 | 180 | 270;

export type DiagramQuality = {
  score: number;
  reconstructable: boolean;
  kind: DiagramKind;
  issues: string[];
  capture?: DiagramCapture;
  rotation?: DiagramRotation;
};

export type GeoGebraStyle = {
  target: string;
  color: string;
  lineStyle: number;
  lineThickness: number;
  pointSize: number;
  labelVisible: boolean;
};

export type GeoGebraPointRole = "base" | "midpoint" | "intersection" | "dependent";

export type GeoGebraReferencePoint = {
  label: string;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  markerVisible: boolean;
  role: GeoGebraPointRole;
};

export type GeoGebraPlan = {
  diagramType: Exclude<DiagramKind, "unsupported">;
  confidence: number;
  commands: string[];
  styles: GeoGebraStyle[];
  view: { xMin: number; xMax: number; yMin: number; yMax: number };
  sourceAspectRatio: number;
  referencePoints: GeoGebraReferencePoint[];
  expectedLabels: string[];
  constraints: string[];
  warnings: string[];
};

export type VectorDiagramPoint = { x: number; y: number };

export type VectorDiagramStroke = {
  id: string;
  points: VectorDiagramPoint[];
  closed: boolean;
  width: number;
  color: string;
  dash: number[];
};

export type VectorDiagramEllipse = {
  id: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  width: number;
  color: string;
  dash: number[];
};

export type VectorDiagramLabel = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  italic: boolean;
  bold: boolean;
  anchor: "start" | "middle" | "end";
};

export type VectorDiagramMarker = {
  x: number;
  y: number;
  radius: number;
  color: string;
};

export type VectorDiagramPlan = {
  diagramType: Exclude<DiagramKind, "unsupported">;
  confidence: number;
  sourceAspectRatio: number;
  strokes: VectorDiagramStroke[];
  ellipses: VectorDiagramEllipse[];
  labels: VectorDiagramLabel[];
  markers: VectorDiagramMarker[];
  expectedLabels: string[];
  constraints: string[];
  geogebraCommands: string[];
  warnings: string[];
  excludedAnnotations?: string[];
};

export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  moduleId?: string;
  createdAt: number;
  createdBy?: string | null;
};

export type LibraryModule = {
  id: string;
  name: string;
  subtitle: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type Question = {
  id: string;
  /** Stable library lookup ID; at least four digits. Assigned by the server. */
  code?: string;
  moduleId?: string;
  categoryId: string;
  type: QuestionType;
  difficulty: Difficulty;
  provenance?: QuestionProvenance;
  examYear?: string;
  stem: string;
  stemParagraphs?: string[];
  stemDocxXml?: string[];
  stemDocxAssets?: Record<string, string>;
  options: string[];
  optionsDocxXml?: string[];
  optionsDocxAssets?: Record<string, string>;
  answer: string;
  analysis: string;
  studioSource?: import("./answer-studio").StudioQuestion;
  analysisDocxXml?: string[];
  analysisDocxAssets?: Record<string, string>;
  source: string;
  tags?: string[];
  tagsZh?: string[];
  tagsEn?: string[];
  taxonomyKeys?: string[];
  contentImages?: string[];
  imageLayout?: ImageLayout;
  optimizedAt?: number;
  originalImage?: string;
  diagramImage?: string;
  /** Options printed as drawings: one picture of all of them with their letters, shown where the options go. */
  optionsImage?: string;
  diagramOriginalImage?: string;
  diagramSource?: DiagramSource;
  diagramQuality?: DiagramQuality;
  geogebraBase64?: string;
  geogebraPlan?: GeoGebraPlan;
  vectorDiagramSvg?: string;
  vectorDiagramPlan?: VectorDiagramPlan;
  diagramReconstructionConfidence?: number;
  diagramVisualFitScore?: number;
  diagramReconstructionWarnings?: string[];
  diagramReconstructedAt?: number;
  diagramBox?: { x: number; y: number; width: number; height: number };
  recognitionConfidence?: number;
  recognitionDurationMs?: number;
  diagramReconstructionDurationMs?: number;
  recognitionWarnings?: string[];
  importFileName?: string;
  sourcePage?: number;
  createdAt: number;
  updatedAt: number;
  createdBy?: string | null;
  createdByEmail?: string | null;
  canEdit?: boolean;
};

export type LibraryData = {
  scope: LibraryScope;
  modules: LibraryModule[];
  categories: Category[];
  questions: Question[];
  publishedAt?: number | null;
};

// A handout references library questions or its own temporary question snapshots by id.
// A section is a knowledge module (title + 知识点); each 讲义 question sits in one of its bands.
// 一讲有讲义、小测、作业三份资料。小测和作业各是一列题，每道题记着它考的是哪个模块（讲义没有模块时为 null）。
export type HandoutBand = "example" | "practice" | "variant";
export type HandoutSheet = "handout" | "quiz" | "homework";
export type HandoutItem =
  | { id: string; kind: "question"; scope: LibraryScope; questionId: string; band: HandoutBand }
  | { id: string; kind: "section"; title: string; note: string }
  | { id: string; kind: Exclude<HandoutSheet, "handout">; scope: LibraryScope; questionId: string; moduleId: string | null };

// 已有深圳创新知识图谱中的初一至初三记为 7–9。
export type HandoutGrade = 7 | 8 | 9;
export type HandoutShelf = "course" | "topic" | "student";
// 专题分组的稳定目录 ID；旧分类和大纲目录直属讲义保留原位置，等待归类。
export type HandoutDomain = string;
// 课程体系和专题库复用同一棵目录树，专题挂在固定的专题库根目录下。
export type HandoutCourseNode = { id: string; parentId: string | null; name: string; position: number };
export type HandoutGroup = { courseUnitId: string | null; domain: HandoutDomain | null; studentId: string | null };

export type Handout = HandoutGroup & {
  // Shared breadcrumb: course system/stage/unit or topic library/category/outline/group.
  coursePath: HandoutCourseNode[];
  domainName: string | null;
  id: string;
  title: string;
  items: HandoutItem[];
  temporaryQuestions: Question[];
  // Only the student's own teacher ever receives a student handout, so the name travels with it.
  studentName: string | null;
  // position orders lessons in a unit, topics in a domain, or a student's handouts.
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type HandoutOutline = { title: string; questionIds: string[] }[];
// How many questions a module holds in each band of the 讲义 and in the 小测 and 作业 that test it.
export type HandoutModuleCounts = Record<HandoutBand | Exclude<HandoutSheet, "handout">, number>;
// One lesson of the 课程体系 as the course knowledge graph sees it.
export type CourseLessonDetail = { id: string; title: string; grade: HandoutGrade; modules: { id: string; title: string; counts: HandoutModuleCounts }[] };
export type HandoutSummary = Omit<Handout, "items" | "temporaryQuestions"> & { outline: HandoutOutline; sheetCounts: Record<Exclude<HandoutSheet, "handout">, number> };

// 快速排版的历史记录：只属于排它的老师。settings 是当时的排版设置。Word 记录（word）另行读取原始 Word，打开时按原样
// 再读一遍；智能组卷的记录（library）是一份按天分好的题库题目清单（plan），打开时按题目 ID 取题库原题。
export type TypesetSettings = { answers: "none" | "end" | "each"; showSource?: boolean; linePitch: number; groupRoom: Record<string, number>; ownRoom: Record<string, number> };
export type TypesetRecord = {
  id: string; title: string; fileName: string; questionCount: number; settings: Partial<TypesetSettings>; createdAt: number; updatedAt: number;
  sourceKind: "word" | "library"; studentId: string | null; studentName: string | null; plan: SmartPaperPlan | null;
};

// 智能组卷的方案：老师的原话、agent 对需求的理解、从学生档案里看到的问题，以及按天挑好的题。
// 每道题记着它针对的侧重点和挑它的理由；系统补选的题理由写明“系统补选”。
export type SmartPaperItem = { id: string; focus: string; reason: string };
export type SmartPaperGroup = { title: string; theme: string; items: SmartPaperItem[] };
export type SmartPaperBrief = { title: string; days: number; perDay: number; categoryIds: string[]; questionTypes: QuestionType[]; difficulty: string; focus: { label: string; description: string }[] };
export type SmartPaperPlan = {
  request: string; studentId: string | null; brief: SmartPaperBrief; findings: { label: string; evidence: string }[];
  // How many questions in range were left out because this student already met them (wrong book or earlier plans).
  avoided: number; groups: SmartPaperGroup[];
};

// 共享办公 · 成员。停用的账号保留数据但不能登录。
export type TeamMember = { id: string; email: string; role: "admin" | "member"; createdAt: number; disabledAt: number | null; lastLoginAt: number | null };
// code: 页面生成的邀请码；config: 沿用配置文件里的邀请码；closed: 已关闭注册；none: 还没有邀请码。
export type TeamInvite = { mode: "code" | "config" | "closed" | "none"; code: string | null };

export type AuthUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  local?: boolean;
};

export type Student = {
  id: string;
  name: string;
  className: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
};

export type StudentSummary = Student & {
  wrongCount: number;
};

// 定档: what the archive knows about a student. 客观 comes from graded homework (knowledge points and question types),
// 主观 from what the teacher said after a lesson, read against five fixed abilities.
export type AbilityKey = "careless" | "calculation" | "thinking-reverse" | "thinking-analysis" | "thinking-transform";
export type AbilityNote = { key: AbilityKey; polarity: "strength" | "weakness"; evidence: string };
/** One lesson's feedback: the teacher's words and what was read from them (extractedAt is null until a reading succeeds). */
export type StudentObservation = {
  id: string; studentId: string; observedAt: number; text: string; abilities: AbilityNote[]; keywords: string[];
  extractedAt: number | null; createdAt: number; updatedAt: number;
};
/** Graded answers on one knowledge point (or its topic or domain) and one question type. */
export type KnowledgeTally = { key: string; label: string; level: "domain" | "topic" | "point"; parentKey: string | null; correct: number; partial: number; incorrect: number; lastAt: number };
export type StudentProfileSummary = {
  since: number | null;
  knowledge: KnowledgeTally[];
  types: Array<{ type: QuestionType; correct: number; partial: number; incorrect: number }>;
  observations: StudentObservation[];
};

/**
 * 学情报告 for parents over one period. `data` is a snapshot of what the archive held when the report was made (so a
 * report sent stays as it was); `text` is what the model wrote from it and the teacher may edit.
 */
export type StudentReportData = {
  studentName: string; className: string;
  homework: Array<Pick<StudentHomework, "title" | "assigned" | "createdAt" | "total" | "done" | "correct" | "incorrect" | "pending">>;
  knowledge: KnowledgeTally[]; types: StudentProfileSummary["types"];
  observations: Array<Pick<StudentObservation, "observedAt" | "text" | "abilities">>;
  wrongAdded: number;
};
export type StudentReportText = { overview: string; knowledge: string; abilities: string; plan: string[]; message: string };
export type StudentReport = { id: string; studentId: string; periodStart: number; periodEnd: number; data: StudentReportData; text: StudentReportText; createdAt: number; updatedAt: number };

/** archiveReason of a wrong question the teacher deleted. It waits in 历史记录 and can be restored; other archived entries follow grading. */
export const WRONG_QUESTION_DELETED = "老师删除";

export type WrongQuestionEntry = {
  id: string;
  studentId: string;
  sourceScope: LibraryScope;
  sourceQuestionId: string;
  sourcePath: string;
  question: Question;
  mistakeCount: number;
  lastWrongAt: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  archiveReason?: string;
  sourceKind?: "library" | "assignment";
  assignmentId?: string | null;
  submissionId?: string | null;
  gradingItemId?: string | null;
  studentAnswer?: string;
  feedback?: string;
  answerCropAssetId?: string | null;
};

export type SubmissionStatus = "draft" | "submitted" | "processing" | "review_required" | "ready" | "published" | "failed";
/** What a graded homework feeds besides its own grading record; chosen per homework at upload. */
export type HomeworkOutputs = { wrongBook: boolean; report: boolean; profile: boolean };
/** school: 校内数学, graded per printed question; international: IGCSE / A Level, graded per sub-part against a mark scheme. */
export type HomeworkCurriculum = "school" | "international";
export type GradingVerdict = "correct" | "partial" | "incorrect" | "unreadable" | "review_required";
export type HomeworkAssetRole = "question" | "answer" | "submission_original" | "submission_document" | "answer_crop";
/** A printed figure cut from the homework page; options figures hold every option graph with its letter. */
export type HomeworkQuestionFigure = { url: string; kind: "stem" | "options"; width?: number; height?: number; hasHandwriting?: boolean };

export type HomeworkAsset = {
  id: string;
  role: HomeworkAssetRole;
  url: string;
  contentType: string;
  byteSize: number;
  originalName: string;
  createdAt: number;
};

export type AssignmentQuestion = {
  id: string;
  assignmentId: string;
  questionNumber: string;
  pageNumber: number;
  type: QuestionType;
  stem: string;
  options: string[];
  answer: string;
  analysis: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
  referenceSource?: "provided" | "agent" | "unresolved";
  referenceVerified?: boolean;
  referenceEvidence?: string;
  confidence: number;
  warnings: string[];
  knowledgeTags: string[];
  taxonomyKeys: string[];
  capabilityKeys: string[];
  figures?: HomeworkQuestionFigure[];
  /** An assigned homework's question as it was handed out: the library question or the one read from the Word. */
  source?: Question | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

/** How an assigned material is split (智能组卷 by day); no groups means one run of questions numbered 1, 2, 3…. */
export type HomeworkSheetGroup = { title: string; size: number };
/** One day's task group (a sheet without groups is one task), with progress and its actual submission time. */
export type HomeworkDay = HomeworkSheetGroup & {
  done: number; correct: number; incorrect: number; pending: number;
  /** Each question's first published attempt; later corrections do not replace these marks. */
  firstAttempt: Pick<HomeworkDay, "correct" | "incorrect" | "pending">;
  /** When the first upload that found any of its questions was handed in. */
  handedInAt: number | null;
};
/**
 * An assigned homework: its questions were known when it was handed out, and it may come back in several uploads.
 * Each question carries its latest graded result over the uploads so far; one never handed in has none.
 */
export type AssignedHomework = {
  days: HomeworkDay[];
  questions: Array<{ id: string; number: string; question: Question; result: (Pick<GradingItem, "verdict" | "requiresReview" | "teacherMark" | "standardAnswer" | "referenceVerified"> & { submissionId: string; wasIncorrect: boolean }) | null }>;
  uploads: Array<{ id: string; version: number; status: SubmissionStatus; pageCount: number; createdAt: number; submittedAt: number | null }>;
};

/** One homework of a student as the archive lists it: assigned ones count the whole sheet, uploaded ones their last upload. */
export type StudentHomework = {
  assignmentId: string; title: string; assigned: boolean; createdAt: number;
  total: number; done: number; correct: number; incorrect: number; pending: number;
  latest: { id: string; status: SubmissionStatus; version: number; updatedAt: number };
  /** An assigned homework's days, and the 快速排版 record it was assigned from; null for an uploaded one. */
  days: HomeworkDay[] | null; recordId: string | null;
};

export type SubmissionPage = {
  id: string;
  submissionId: string;
  pageOrder: number;
  originalAssetId: string;
  processedAssetId: string;
  originalUrl: string;
  processedUrl: string;
  createdAt: number;
};

export type GradingItem = {
  id: string;
  submissionId: string;
  assignmentQuestionId: string;
  pageId: string | null;
  questionNumber: string;
  questionType: QuestionType;
  stem: string;
  figures?: HomeworkQuestionFigure[];
  standardAnswer: string;
  standardAnalysis: string;
  referenceSource?: "provided" | "agent" | "unresolved";
  referenceVerified?: boolean;
  referenceEvidence?: string;
  /** The tick, half tick or cross the teacher had already put beside this answer; such an item is judged by it. */
  teacherMark?: "correct" | "partial" | "incorrect" | null;
  verdict: GradingVerdict;
  score: number | null;
  maxScore: number | null;
  studentAnswer: string;
  feedback: string;
  errorType: string;
  stepAnalysis: string[];
  evidenceSummary: string;
  capabilityKeys: string[];
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  requiresReview: boolean;
  reviewedAt: number | null;
  correctedAt: number | null;
  wrongBookAppliedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** Marks of one homework: the denominator is the whole paper, so pending questions keep the percentage open. */
export type HomeworkScoreSummary = { score: number; maxScore: number; pending: number; percentage: number | null };

export type SubmissionReportPoint = {
  title: string;
  detail: string;
  questionNumbers: string[];
  capabilityKey: string | null;
};

/** IGCSE / A Level report, read by parents and students together; marks always come from the grading items. */
export type InternationalReport = {
  overview: string;
  priorities: string[];
  topics: Array<{ question: string; topic: string; note: string }>;
  losses: Array<{ section: string; questionNumbers: string[]; title: string; fact: string; knowledge: string; method: string; action: string }>;
  practice: Array<{ focus: string; action: string; standard: string }>;
  checklist: string;
};

export type SubmissionReport = {
  details?: InternationalReport | null;
  overallSummary: string;
  studentMessage: string;
  strengths: SubmissionReportPoint[];
  gaps: SubmissionReportPoint[];
  actions: string[];
  warnings: string[];
  generatedAt: number;
  updatedAt: number;
};

export type CapabilityDimension = "knowledge" | "skill";
export type CapabilityStatus = "stable" | "developing" | "attention" | "insufficient";

export type CapabilityNode = {
  key: string;
  label: string;
  dimension: CapabilityDimension;
  description: string;
  level: "domain" | "topic" | "point" | "micro" | "capability";
  parentKey?: string;
  domainKey: string;
  stage: number;
  aliases?: string[];
  color?: string;
  order?: number;
};

export type CapabilityEdge = {
  sourceKey: string;
  targetKey: string;
  relationship: "prerequisite" | "supports";
  strength: "hard" | "soft";
  reason: string;
};

export type TextbookEdition = {
  key: string;
  label: string;
  publisher: string;
};

export type TextbookTopicMapping = {
  nodeKey: string;
  editionKey: string;
  grade: number;
  volume: string;
  unitLabel: string;
  alignmentStatus: "framework" | "verified";
};

export type CapabilityEvidence = {
  id: string;
  capabilityKey: string;
  capabilityLabel: string;
  dimension: CapabilityDimension;
  verdict: Extract<GradingVerdict, "correct" | "partial" | "incorrect">;
  confidence: number;
  diagnosis: string;
  assignmentId: string;
  submissionId: string;
  gradingItemId: string;
  createdAt: number;
};

export type CapabilityProfileNode = CapabilityNode & {
  status: CapabilityStatus;
  evidenceCount: number;
  summary: string;
  textbookMappings: Array<TextbookTopicMapping & { editionLabel: string }>;
  recentEvidence: Array<{ questionNumber: string; verdict: CapabilityEvidence["verdict"]; diagnosis: string; assignmentId: string; createdAt: number }>;
};

export type StudentCapabilityProfile = {
  frameworkVersion: string;
  studentId: string;
  nodes: CapabilityProfileNode[];
  edges: CapabilityEdge[];
  textbookEditions: TextbookEdition[];
  updatedAt: number;
};

export type KnowledgeGraphLevel = "domain" | "topic" | "point";
export type KnowledgeGraphStage = { value: number; label: string };

export type KnowledgeGraphNode = {
  key: string;
  label: string;
  level: KnowledgeGraphLevel;
  parentKey?: string;
  domainKey: string;
  stage: number;
  description: string;
  mastery?: string;
  aliases: string[];
  order: number;
  status: "active" | "archived";
  color?: string;
  mergedInto?: string;
};

export type KnowledgeGraphDocument = {
  schemaVersion: 2;
  graphId: string;
  title: string;
  scope: string;
  status: "foundation" | "verified";
  stages: KnowledgeGraphStage[];
  nodes: KnowledgeGraphNode[];
  edges: CapabilityEdge[];
  editions: TextbookEdition[];
  mappings: TextbookTopicMapping[];
};

export type KnowledgeGraphIssue = { code: string; message: string; nodeKey?: string; sourceKey?: string; targetKey?: string; cycle?: string[] };

export type KnowledgeGraphChangeSummary = {
  nodesAdded: number; nodesUpdated: number; nodesArchived: number; nodesRemoved: number;
  edgesAdded: number; edgesUpdated: number; edgesRemoved: number; meta: number;
};

export type PublishedKnowledgeGraph = {
  graphId: string;
  version: number;
  frameworkVersion: string;
  publishedAt: number | null;
  note: string;
  document: KnowledgeGraphDocument;
};

export type KnowledgeGraphDraft = { document: KnowledgeGraphDocument; baseVersion: number; updatedAt: number; issues: KnowledgeGraphIssue[] };
export type KnowledgeGraphEditorState = { published: PublishedKnowledgeGraph; draft: KnowledgeGraphDraft | null; revision: number };
export type KnowledgeGraphVersion = { version: number; frameworkVersion: string; publishedAt: number | null; note: string; summary: KnowledgeGraphChangeSummary | null };
// public: library questions tagged with each node. handouts (course graph): questions each lesson and module holds.
export type KnowledgeGraphCoverage = { public: Record<string, number>; handouts?: Record<string, HandoutModuleCounts> };

export type KnowledgeGraphOverview = {
  profile: StudentCapabilityProfile;
  graph: PublishedKnowledgeGraph;
  coverage: KnowledgeGraphCoverage;
  permissions: { canEdit: boolean };
};

export type HomeworkSubmission = {
  processingProgress?: {identified:number;referenceChecked:number;graded:number};
  pageCoverage?: {total:number;processed:number;unreadable:number;missing:number[];pages:Array<{pageNumber:number;valid:boolean;kind:string|null;reason:string}>};
  figuresPending?: number;
  outputs: HomeworkOutputs;
  curriculum: HomeworkCurriculum;
  originalDocuments?: Array<{name:string;url:string}>;
  questionOriginals?: Array<{name:string;url:string}>;
  pageRevisions?: Array<{ pageId:string; originalUrl:string; processedUrl:string; createdAt:number }>;
  gradingSummary?: { correct: number; partial: number; incorrect: number; unresolved: number; archived: number; marks: HomeworkScoreSummary | null };
  id: string;
  assignmentId: string;
  assignmentTitle: string;
  studentId: string;
  studentName: string;
  version: number;
  status: SubmissionStatus;
  submittedAt: number | null;
  publishedAt: number | null;
  failureReason: string;
  pages: SubmissionPage[];
  gradingItems: GradingItem[];
  report: SubmissionReport | null;
  /** Present on an assigned homework: the whole sheet with each question's latest result. */
  assigned?: AssignedHomework | null;
  /** Existing processing scope, retained across reloads for an upload of selected mistakes. */
  questionScope?: string[];
  createdAt: number;
  updatedAt: number;
};
