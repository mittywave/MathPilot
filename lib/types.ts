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
  loginId: string;
  wrongCount: number;
  reviewingCount: number;
  masteredCount: number;
};

export type WrongQuestionEntry = {
  id: string;
  studentId: string;
  sourceScope: LibraryScope;
  sourceQuestionId: string;
  sourcePath: string;
  question: Question;
  mistakeCount: number;
  note: string;
  mastered: boolean;
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

export type HomeworkClass = {
  id: string;
  name: string;
  studentIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type StudentAccount = {
  studentId: string;
  loginId: string;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type StudentAuth = {
  studentId: string;
  ownerUserId: string;
  name: string;
  loginId: string;
  teacherCode: string;
  mustChangePassword: boolean;
};

export type AssignmentStatus = "draft" | "published" | "closed" | "archived";
export type SubmissionStatus = "draft" | "submitted" | "processing" | "review_required" | "ready" | "published" | "returned" | "failed";
export type GradingVerdict = "correct" | "partial" | "incorrect" | "unreadable" | "review_required";
export type HomeworkAssetRole = "question" | "answer" | "submission_original" | "submission_processed" | "submission_document" | "answer_crop";

export type HomeworkAsset = {
  id: string;
  role: HomeworkAssetRole;
  url: string;
  contentType: string;
  byteSize: number;
  originalName: string;
  pageOrder: number;
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
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type Assignment = {
  inputMode?: "template" | "completed_homework";
  id: string;
  title: string;
  instructions: string;
  status: AssignmentStatus;
  dueAt: number | null;
  templateConfirmed: boolean;
  targetStudentIds: string[];
  questions: AssignmentQuestion[];
  assets: HomeworkAsset[];
  submissionCounts: Record<SubmissionStatus, number>;
  createdAt: number;
  updatedAt: number;
};

export type SubmissionPage = {
  id: string;
  submissionId: string;
  pageOrder: number;
  originalAssetId: string;
  processedAssetId: string;
  originalUrl: string;
  processedUrl: string;
  quality: { score: number; warnings: string[]; corners?: Array<{ x: number; y: number }> };
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
  standardAnswer: string;
  standardAnalysis: string;
  referenceSource?: "provided" | "agent" | "unresolved";
  referenceVerified?: boolean;
  referenceEvidence?: string;
  verdict: GradingVerdict;
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

export type SubmissionReportPoint = {
  title: string;
  detail: string;
  questionNumbers: string[];
  capabilityKey: string | null;
};

export type SubmissionReport = {
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
  currentEvidenceCount: number;
  highlighted: boolean;
  summary: string;
  textbookMappings: Array<TextbookTopicMapping & { editionLabel: string }>;
  recentEvidence: Array<{ questionNumber: string; verdict: CapabilityEvidence["verdict"]; diagnosis: string; assignmentId: string; createdAt: number }>;
};

export type StudentCapabilityProfile = {
  frameworkVersion: string;
  studentId: string;
  assignmentId: string | null;
  nodes: CapabilityProfileNode[];
  edges: CapabilityEdge[];
  textbookEditions: TextbookEdition[];
  viewMode: "teacher" | "student";
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
export type KnowledgeGraphCoverage = { public: Record<string, number>; mine: Record<string, number> };

export type KnowledgeGraphOverview = {
  profile: StudentCapabilityProfile;
  graph: PublishedKnowledgeGraph;
  coverage: KnowledgeGraphCoverage;
  permissions: { canEdit: boolean };
};

export type HomeworkSubmission = {
  processingProgress?: {identified:number;referenceChecked:number;graded:number};
  pageCoverage?: {total:number;processed:number;unreadable:number;missing:number[];pages:Array<{pageNumber:number;valid:boolean;kind:string|null;reason:string}>};
  inputMode?: "template" | "completed_homework";
  originalDocuments?: Array<{name:string;url:string}>;
  pageRevisions?: Array<{ pageId:string; originalUrl:string; processedUrl:string; createdAt:number }>;
  gradingSummary?: { correct: number; partial: number; incorrect: number; unresolved: number; archived: number };
  id: string;
  assignmentId: string;
  assignmentTitle: string;
  studentId: string;
  studentName: string;
  version: number;
  status: SubmissionStatus;
  submittedByType: "teacher" | "student";
  submittedAt: number | null;
  publishedAt: number | null;
  returnedAt: number | null;
  failureReason: string;
  pages: SubmissionPage[];
  gradingItems: GradingItem[];
  report: SubmissionReport | null;
  createdAt: number;
  updatedAt: number;
};
