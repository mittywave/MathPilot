import { MathText } from "../../components/MathText";
import { parseHandoutNote, type NoteSpan } from "../../../lib/handout-note.mjs";

function Spans({ spans }: { spans: NoteSpan[] }) {
  return <>{spans.map((span, index) => span.bold ? <strong key={index}><MathText text={span.text} /></strong> : <MathText key={index} text={span.text} />)}</>;
}

// Reads the note exactly as the PDF and Word exports do.
export function NotePreview({ note }: { note: string }) {
  return <div className="note-preview">{parseHandoutNote(note).map((line, index) => {
    if (line.kind === "figures") return <div key={index} className="note-figure-row">
      {line.figures.map((figure, figureIndex) => <figure key={figureIndex} className="note-figure">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={figure.src} alt="知识点配图" />
        {figure.caption.length > 0 && <figcaption><Spans spans={figure.caption} /></figcaption>}
      </figure>)}
      {line.side.length > 0 && <div className="note-figure-side">{line.side.map((spans, lineIndex) => <p key={lineIndex}><Spans spans={spans} /></p>)}</div>}
    </div>;
    if (line.kind === "heading") {
      const Heading = (["h3", "h4", "h5"] as const)[line.level - 1];
      return <Heading key={index}><Spans spans={line.spans} /></Heading>;
    }
    if (line.kind === "item") return <p key={index} className="note-item"><b>{line.marker}</b><span><Spans spans={line.spans} /></span></p>;
    return <p key={index}><Spans spans={line.spans} /></p>;
  })}</div>;
}
