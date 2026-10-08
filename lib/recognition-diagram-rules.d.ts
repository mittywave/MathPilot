import type { RecognitionBox } from "./recognition-contract";
import type { CropOptions } from "./image-tools";
import type { DiagramQuality } from "./types";

export const MIN_RECOGNITION_DIAGRAM_EDGE: number;
export function hasUsableRecognitionDiagramBox(box: RecognitionBox | null | undefined): boolean;
export function recognitionDiagramCropOptions(quality: DiagramQuality | null | undefined): CropOptions;
export function shouldReconstructRecognizedDiagram(diagramImage: string | undefined, quality: DiagramQuality | null | undefined): boolean;
