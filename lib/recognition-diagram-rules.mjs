import { correctionForCapturedRotation, isPhotographedDiagram } from "./image-processing-rules.mjs";
import { shouldAutoVectorizeDiagram } from "./vector-diagram-reconstruction.mjs";

export const MIN_RECOGNITION_DIAGRAM_EDGE = 20;

export function hasUsableRecognitionDiagramBox(box) {
  return Boolean(box && box.width >= MIN_RECOGNITION_DIAGRAM_EDGE && box.height >= MIN_RECOGNITION_DIAGRAM_EDGE);
}

export function recognitionDiagramCropOptions(quality) {
  return {
    photographed: isPhotographedDiagram(quality),
    rotation: correctionForCapturedRotation(quality?.rotation),
    kind: quality?.kind,
  };
}

// The figure is redrawn only when its quality calls for it; nobody has to switch it on.
export function shouldReconstructRecognizedDiagram(diagramImage, quality) {
  return Boolean(diagramImage && shouldAutoVectorizeDiagram(quality));
}
