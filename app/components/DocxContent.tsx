"use client";

import { Fragment, useMemo } from "react";
import { parseDocxWebContent, parseDocxWebOptions, type DocxWebBlock, type DocxWebInline } from "../../lib/docx-web-content";
import { plainTextWebLines } from "../../lib/math-text";
import { optionColumnCount } from "../../lib/question-presentation-rules.mjs";
import { MathText } from "./MathText";

function InlineContent({ inlines, assets, imageAlt = "配图" }: { inlines: DocxWebInline[]; assets?: Record<string, string>; imageAlt?: string }) {
  return inlines.map((inline, index) => {
    const key = `inline-${index}`;
    if (inline.type === "math") return <MathText text={`$${inline.latex}$`} key={key} />;
    // eslint-disable-next-line @next/next/no-img-element
    if (inline.type === "image") return assets?.[inline.id] ? <img key={key} src={assets[inline.id]} alt={imageAlt} style={{ width: `${inline.width}mm`, maxWidth: "100%", height: "auto", display: "inline-block", verticalAlign: "middle" }} /> : null;
    if (inline.type === "tab") return <span className="docx-web-tab" aria-hidden="true" key={key} />;
    if (inline.type === "break") return <br key={key} />;
    const classes = [inline.bold && "docx-run-bold", inline.italic && "docx-run-italic", inline.underline && "docx-run-underline"].filter(Boolean).join(" ");
    const text = <span className={classes || undefined}>{inline.value}</span>;
    if (inline.vertical === "sup") return <sup key={key}>{text}</sup>;
    if (inline.vertical === "sub") return <sub key={key}>{text}</sub>;
    return <Fragment key={key}>{text}</Fragment>;
  });
}

function Blocks({ blocks, assets, tableDepth = 0 }: { blocks: DocxWebBlock[]; assets?: Record<string, string>; tableDepth?: number }) {
  return blocks.map((block, index) => {
    if (block.type === "paragraph") {
      return <p className={`docx-web-paragraph align-${block.align}`} key={`paragraph-${index}`}><InlineContent inlines={block.inlines} assets={assets} /></p>;
    }
    return <div className={`docx-web-table-wrap depth-${Math.min(tableDepth, 2)}`} key={`table-${index}`}>
      <table className="docx-web-table"><tbody>{block.rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>
        {row.map((cell, cellIndex) => <td colSpan={cell.colSpan} rowSpan={cell.rowSpan} key={`cell-${cellIndex}`}><Blocks blocks={cell.blocks} assets={assets} tableDepth={tableDepth + 1} /></td>)}
      </tr>)}</tbody></table>
    </div>;
  });
}

export function DocxContent({ xml, fallback, assets, stripLeadingQuestionNumber = false, className = "" }: { xml?: string[]; fallback: string; assets?: Record<string, string>; stripLeadingQuestionNumber?: boolean; className?: string }) {
  const content = useMemo(() => parseDocxWebContent(xml ?? [], { stripLeadingQuestionNumber, pictures: Boolean(assets) }), [xml, assets, stripLeadingQuestionNumber]);
  const fallbackLines = useMemo(() => plainTextWebLines(fallback, { stripLeadingQuestionNumber }), [fallback, stripLeadingQuestionNumber]);
  if (!content.blocks.length) return <div className={`docx-web-content ${className}`.trim()}>{fallbackLines.map((line, index) =>
    <p className={`docx-web-paragraph align-${line.align}`} key={`fallback-paragraph-${index}`}>{line.value ? <MathText text={line.value} /> : <br />}</p>)}</div>;
  return <div className={`docx-web-content ${className}`.trim()}><Blocks blocks={content.blocks} assets={assets} /></div>;
}

export function DocxOptions({ xml, fallback, assets }: { xml?: string[]; fallback: string[]; assets?: Record<string, string> }) {
  const parsed = useMemo(() => parseDocxWebOptions(xml ?? []), [xml]);
  const parsedByLabel = new Map(parsed.map((option) => [option.label, option]));
  const count = Math.max(fallback.length, parsed.length);
  const hasLongFormula = parsed.some((option) => option.inlines.some((inline) => inline.type === "image" && inline.width > 30 || inline.type === "math" && ((inline.latex.match(/\\frac/g) ?? []).length >= 2 || inline.latex.length > 48)));
  if (!count) return null;
  return <div className={`options docx-web-options ${hasLongFormula || optionColumnCount(fallback) === 2 ? "long-formula" : "compact-options"}`} data-option-count={count}>{Array.from({ length: count }, (_, index) => {
    const label = String.fromCharCode(65 + index);
    const option = parsedByLabel.get(label);
    return <div className="docx-web-option" key={label}><span className="docx-web-option-label">{label}.</span><span className="docx-web-option-content">{option ? <InlineContent inlines={option.inlines} assets={assets} imageAlt="选项配图" /> : <MathText text={fallback[index] ?? ""} />}</span></div>;
  })}</div>;
}
