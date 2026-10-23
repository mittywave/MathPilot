"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, isHistoryTransaction, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Slice, type Node as ProseNode } from "prosemirror-model";
import { EditorState, NodeSelection, Plugin, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import { renderKatex } from "./MathText";
import { convertTypedMarkup, docFromNote, docFromText, itemMarker, itemMarkerWidth, noteFromContent, noteFromDoc, noteSchema, sliceFromNote, sliceFromText, textFromContent, textFromDoc } from "../../lib/handout-note-doc";
import { splitMathText } from "../../lib/math-text";
import "./note-editor.css";

// 知识点 are edited as they read: headings, bold text, formulas and rows of figures stay formatted while typing.
// The note is still saved as the light markup the PDF and Word exports read (lib/handout-note-doc.ts).
// Question text uses the same editor with plainText: formulas only, saved exactly as plain lines with $…$;
// singleLine keeps an option or answer on one line.
type Props = { value: string; label: string; placeholder: string; onChange: (note: string) => void; onCommit?: () => void; plainText?: boolean; singleLine?: boolean };
type Tools = { heading: boolean; bold: boolean; canHeading: boolean; canBold: boolean; canFormula: boolean };
type MathEdit = { pos: number; latex: string; original: Slice | null; top: number; left: number; above: boolean; opened: number };

const EXTERNAL = "note-external";
const { paragraph, heading, figure, side_line: sideLine, math } = noteSchema.nodes;
const bold = noteSchema.marks.bold;
const toggleBold = toggleMark(bold);
// 小标题 turns a line into a heading and back; captions and the note beside figures stay as they are.
const toggleHeading: Command = (state, dispatch) => {
  const parent = state.selection.$from.parent.type;
  if (parent !== paragraph && parent !== heading) return false;
  return setBlockType(parent === heading ? paragraph : heading, parent === heading ? undefined : { level: 2 })(state, dispatch);
};
const inFigureText = (state: EditorState) => [figure, sideLine].includes(state.selection.$from.parent.type);
// Enter in a caption starts a new line after the row of figures. In the note beside the row Enter starts its
// next line (one step per line); Enter on an empty last line leaves the row.
const leaveFigureRow: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type === sideLine) {
    const lastLine = $from.index(-1) === $from.node(-1).childCount - 1;
    if ($from.parent.content.size || !lastLine) return false;
    const after = $from.after(-2);
    if (dispatch) {
      const only = $from.node(-1).childCount === 1;
      const tr = state.tr.delete(only ? $from.before(-1) : $from.before(), only ? $from.after(-1) : $from.after());
      const at = tr.mapping.map(after);
      tr.insert(at, paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
    }
    return true;
  }
  if ($from.parent.type !== figure) return false;
  const after = $from.after(-1);
  if (dispatch) {
    const tr = state.tr.insert(after, paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  }
  return true;
};
// Backspace at the start, or Delete at the end, of a caption never merges it with its neighbours; lines of the
// note beside a row join each other but nothing outside it.
const keepFigureText = (atEnd: boolean): Command => (state) => {
  const { $from, empty } = state.selection;
  if (!empty || !inFigureText(state) || $from.parentOffset !== (atEnd ? $from.parent.content.size : 0)) return false;
  if ($from.parent.type !== sideLine) return true;
  const index = $from.index(-1);
  return atEnd ? index === $from.node(-1).childCount - 1 : index === 0;
};

function toolsFor(state: EditorState): Tools {
  const { selection } = state;
  const marks = state.storedMarks ?? selection.$from.marks();
  return {
    heading: selection.$from.parent.type === heading,
    canHeading: toggleHeading(state),
    bold: selection.empty ? Boolean(bold.isInSet(marks)) : state.doc.rangeHasMark(selection.from, selection.to, bold),
    canBold: toggleBold(state),
    canFormula: !(selection instanceof NodeSelection) || selection.node.type === math,
  };
}
const sameTools = (a: Tools, b: Tools) => a.heading === b.heading && a.bold === b.bold && a.canHeading === b.canHeading && a.canBold === b.canBold && a.canFormula === b.canFormula;

// Tab follows actual cells, including merged ones; leaving either end returns to ordinary note text.
const nextTableCell = (backward: boolean): Command => (state, dispatch) => {
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && $from.node(depth).type !== noteSchema.nodes.table_cell) depth -= 1;
  if (!depth) return false;
  const table = $from.node(depth - 2); const start = $from.before(depth - 2);
  const positions: number[] = [];
  table.descendants((node, pos) => { if (node.type === noteSchema.nodes.table_cell) { positions.push(start + 1 + pos); return false; } });
  const target = positions[positions.indexOf($from.before(depth)) + (backward ? -1 : 1)];
  if (dispatch) {
    const tr = state.tr;
    if (target !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(target + 1)));
    else {
      const at = backward ? start : start + table.nodeSize;
      tr.insert(at, paragraph.create()).setSelection(TextSelection.create(tr.doc, at + 1));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

class MathView implements NodeView {
  dom = document.createElement("span");
  node: ProseNode;
  constructor(node: ProseNode) { this.node = node; this.render(); }
  render() {
    const latex = String(this.node.attrs.latex); const display = this.node.attrs.display === true;
    this.dom.className = "note-math"; this.dom.removeAttribute("title");
    if (!latex.trim()) { this.dom.classList.add("empty"); this.dom.textContent = "公式"; return; }
    const rendered = renderKatex(latex, display);
    if ("error" in rendered) {
      this.dom.classList.add("math-render-error"); this.dom.title = `公式待核对：${rendered.error}`;
      this.dom.textContent = `〔公式待核对〕${latex}`; return;
    }
    this.dom.classList.add("math-formula", display ? "display-math" : "inline-math");
    this.dom.innerHTML = rendered.html;
  }
  update(node: ProseNode) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.latex !== this.node.attrs.latex || node.attrs.display !== this.node.attrs.display;
    this.node = node;
    if (changed) this.render();
    return true;
  }
  selectNode() { this.dom.classList.add("selected"); }
  deselectNode() { this.dom.classList.remove("selected"); }
  ignoreMutation() { return true; }
}

// A figure in a row: the image (click to select, then 删除图片) above its caption, which is typed in place.
class FigureView implements NodeView {
  dom = document.createElement("figure");
  contentDOM = document.createElement("figcaption");
  src: string;
  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.src = String(node.attrs.src);
    const frame = document.createElement("span"); const image = document.createElement("img"); const remove = document.createElement("button");
    this.dom.className = "note-figure"; frame.className = "note-figure-frame"; frame.contentEditable = "false";
    image.src = this.src; image.alt = "知识点配图"; image.draggable = false;
    remove.type = "button"; remove.className = "note-figure-remove"; remove.textContent = "删除图片";
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", () => {
      const pos = getPos(); if (pos == null) return;
      // The last figure of a row takes the whole row with it.
      const $pos = view.state.doc.resolve(pos); let figures = 0;
      $pos.parent.forEach((child) => { if (child.type === figure) figures += 1; });
      const [from, to] = figures > 1 ? [pos, pos + (view.state.doc.nodeAt(pos)?.nodeSize ?? 1)] : [$pos.before(), $pos.after()];
      view.dispatch(view.state.tr.delete(from, to));
      view.focus();
    });
    frame.append(image, remove); this.dom.append(frame, this.contentDOM);
    this.dom.classList.toggle("caption-empty", node.content.size === 0);
  }
  update(node: ProseNode) {
    if (node.type !== figure || node.attrs.src !== this.src) return false;
    this.dom.classList.toggle("caption-empty", node.content.size === 0);
    return true;
  }
  stopEvent(event: Event) { return event.target instanceof Element && Boolean(event.target.closest(".note-figure-remove")); }
  selectNode() { this.dom.classList.add("selected"); }
  deselectNode() { this.dom.classList.remove("selected"); }
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) { return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target); }
}

// Item lines get the preview's hanging indent; letters the exports set as math are set as math here too.
function noteDecorations(placeholder: () => string) {
  return new Plugin({ props: { decorations(state) {
    const { doc } = state; const decorations: Decoration[] = [];
    const only = doc.childCount === 1 ? doc.firstChild : null;
    if (only?.isTextblock && !only.content.size) decorations.push(Decoration.node(0, only.nodeSize, { class: "note-empty", "data-placeholder": placeholder() }));
    doc.descendants((block, offset) => {
      if (!block.isTextblock) return true;
      if (block.type === sideLine && !block.content.size) decorations.push(Decoration.node(offset, offset + block.nodeSize, { class: "note-side-empty" }));
      const marker = itemMarker(block);
      if (marker) {
        decorations.push(Decoration.node(offset, offset + block.nodeSize, { class: "note-item-line", style: `--marker:${itemMarkerWidth(marker)}em` }));
        decorations.push(Decoration.inline(offset + 1, offset + 1 + marker.length, { class: "note-marker" }));
      }
      block.forEach((child, childOffset) => {
        const text = child.text;
        if (!child.isText || !text || text.includes("$")) return;
        const segments = splitMathText(text);
        if (segments.reduce((length, segment) => length + segment.value.length, 0) !== text.length) return;
        let from = offset + 1 + childOffset;
        for (const segment of segments) {
          const to = from + segment.value.length;
          if (segment.kind === "math") {
            decorations.push(Decoration.inline(from, to, { class: "note-auto-math" }));
            for (const letters of segment.value.matchAll(/[A-Za-z]+/g)) {
              const start = from + (letters.index ?? 0);
              decorations.push(Decoration.inline(start, start + letters[0].length, { class: "note-auto-math-letter" }));
            }
          }
          from = to;
        }
      });
      return false;
    });
    return DecorationSet.create(doc, decorations);
  } } });
}

// $…$, **…** or a leading ## typed by hand turns into a formula, bold text or a heading at once (only $…$ in plain text).
const typedMarkup = (formulasOnly: boolean) => new Plugin({
  appendTransaction(transactions, _previous, state) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    if (transactions.some((tr) => tr.getMeta("composition") !== undefined || tr.getMeta(EXTERNAL) || tr.getMeta("paste") || isHistoryTransaction(tr))) return null;
    const { $head } = state.selection;
    if (!$head.parent.isTextblock || $head.depth < 1) return null;
    const tr = state.tr;
    return convertTypedMarkup(tr, $head.before(), formulasOnly) ? tr : null;
  },
});

const editorAttributes = (label: string) => ({ role: "textbox", "aria-multiline": "true", "aria-label": label, class: "note-editor-body note-preview", spellcheck: "false" });

export default function NoteEditor({ value, label, placeholder, onChange, onCommit, plainText = false, singleLine = false }: Props) {
  // The kind of text an editor holds is fixed when it mounts.
  const formatRef = useRef(plainText ? { plainText, singleLine, fromValue: docFromText, toValue: textFromDoc, fromContent: textFromContent, slice: sliceFromText } : { plainText, singleLine, fromValue: docFromNote, toValue: noteFromDoc, fromContent: noteFromContent, slice: sliceFromNote });
  const root = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const mathInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastValue = useRef(value);
  const dirty = useRef(false);
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState<Tools>({ heading: false, bold: false, canHeading: true, canBold: true, canFormula: true });
  const [mathEdit, setMathEdit] = useState<MathEdit | null>(null);
  const live = useRef({ onChange, onCommit, label, placeholder, openMath: (pos: number) => { void pos; } });

  function openMath(pos: number, original: Slice | null = null) {
    const view = viewRef.current; const box = root.current?.getBoundingClientRect();
    const node = view?.state.doc.nodeAt(pos);
    if (!view || !box || node?.type !== math) return;
    const rect = (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect() ?? box;
    // Opens below the formula, or above it when the formula sits low on the screen.
    const above = window.innerHeight - rect.bottom < 240 && rect.top > 240;
    setMathEdit({ pos, latex: String(node.attrs.latex), original, top: (above ? rect.top - 8 : rect.bottom + 8) - box.top, left: Math.max(0, rect.left - box.left), above, opened: Date.now() });
  }

  // Applies the formula being edited (an empty one is removed), or cancels it: a new formula then gives
  // back what was selected, an existing one stays as it was. Returns the change so positions can be mapped.
  function finishMath(edit: MathEdit, refocus: boolean, cancel = false) {
    const view = viewRef.current; setMathEdit(null);
    const node = view?.state.doc.nodeAt(edit.pos);
    if (!view || node?.type !== math) return null;
    const latex = edit.latex.trim(); const tr = view.state.tr;
    if (cancel) { if (edit.original) tr.replace(edit.pos, edit.pos + node.nodeSize, edit.original); }
    else if (!latex) tr.delete(edit.pos, edit.pos + node.nodeSize);
    else if (latex !== node.attrs.latex) tr.setNodeMarkup(edit.pos, undefined, { ...node.attrs, latex });
    if (refocus) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(edit.pos + node.nodeSize))));
    if (tr.docChanged || refocus) view.dispatch(tr);
    if (refocus) view.focus();
    return tr;
  }

  useLayoutEffect(() => {
    live.current = { onChange, onCommit, label, placeholder, openMath: (pos) => {
      const previous = mathEdit ? finishMath(mathEdit, false) : null;
      openMath(previous ? previous.mapping.map(pos) : pos);
    } };
  });

  useLayoutEffect(() => {
    const element = mount.current!;
    const view = new EditorView({ mount: element }, {
      state: EditorState.create({ doc: formatRef.current.fromValue(lastValue.current), plugins: [
        history(),
        keymap({
          "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo, ...(formatRef.current.plainText ? {} : { "Mod-b": toggleBold }),
          Enter: (state) => {
            if (!(state.selection instanceof NodeSelection) || state.selection.node.type !== math) return false;
            live.current.openMath(state.selection.from); return true;
          },
          Escape: (_state, _dispatch, current) => { current?.dom.blur(); return true; },
          "Shift-Enter": leaveFigureRow, Backspace: keepFigureText(false), Delete: keepFigureText(true),
          Tab: nextTableCell(false), "Shift-Tab": nextTableCell(true),
        }),
        keymap(formatRef.current.singleLine ? { Enter: () => true, "Shift-Enter": () => true } : { Enter: leaveFigureRow }),
        keymap(baseKeymap),
        noteDecorations(() => live.current.placeholder),
        typedMarkup(formatRef.current.plainText),
      ] }),
      attributes: editorAttributes(live.current.label),
      // Keeps the caret clear of the toolbar that sticks to the bottom of the screen while editing.
      scrollMargin: { top: 8, bottom: 64, left: 8, right: 8 },
      scrollThreshold: { top: 8, bottom: 64, left: 8, right: 8 },
      nodeViews: {
        math: (node) => new MathView(node),
        figure: (node, current, getPos) => new FigureView(node, current, getPos),
      },
      clipboardTextSerializer: (slice) => formatRef.current.fromContent(slice.content),
      // Screenshots are left to the 知识点 lane, which recognizes them; text is read as note markup.
      handlePaste(current, event) {
        const data = event.clipboardData;
        if (!data) return false;
        if (Array.from(data.files).some((file) => file.type.startsWith("image/"))) return true;
        const text = data.getData("text/plain");
        if (text.trim()) current.dispatch(current.state.tr.replaceSelection(formatRef.current.slice(formatRef.current.singleLine ? text.replace(/\s*\n\s*/g, " ") : text)).setMeta("paste", true).scrollIntoView());
        return true;
      },
      handleDrop: (_current, _event, _slice, moved) => !moved,
      handleClickOn(current, _pos, node, nodePos, event) {
        // In a table, clicking padding or a wrapped line's gap still puts the caret in that cell.
        if (node.type === noteSchema.nodes.table_cell) {
          const at = current.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? nodePos + 1;
          const caret = Math.min(Math.max(at, nodePos + 1), nodePos + node.nodeSize - 1);
          current.dispatch(current.state.tr.setSelection(TextSelection.near(current.state.doc.resolve(caret))));
          return true;
        }
        // Clicking a figure's image selects that figure, ready for 删除图片 or Backspace.
        if (node.type === figure && event.target instanceof HTMLImageElement) {
          current.dispatch(current.state.tr.setSelection(NodeSelection.create(current.state.doc, nodePos)));
          return true;
        }
        // Anywhere else in a figure the caret goes into its caption, at the point nearest the click: the browser
        // may otherwise put it beside the caption, where nothing can be typed.
        if (node.type === figure) {
          const at = current.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? nodePos + 1;
          const caret = Math.min(Math.max(at, nodePos + 1), nodePos + 1 + node.content.size);
          current.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, caret)));
          return true;
        }
        if (node.type !== math) return false;
        current.dispatch(current.state.tr.setSelection(NodeSelection.create(current.state.doc, nodePos)));
        live.current.openMath(nodePos);
        return true;
      },
      dispatchTransaction(this: EditorView, tr: Transaction) {
        const next = this.state.apply(tr);
        this.updateState(next);
        if (tr.docChanged && !tr.getMeta(EXTERNAL)) {
          const note = formatRef.current.toValue(next.doc);
          if (note !== lastValue.current) { lastValue.current = note; dirty.current = true; live.current.onChange(note); }
        }
        const nextTools = toolsFor(next);
        setTools((current) => sameTools(current, nextTools) ? current : nextTools);
      },
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; element.replaceChildren(); };
  }, []);

  useEffect(() => { viewRef.current?.setProps({ attributes: editorAttributes(label) }); }, [label]);

  // A screenshot recognized into this module replaces the content here; it can be undone like typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastValue.current) return;
    lastValue.current = value;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, formatRef.current.fromValue(value).content).setMeta(EXTERNAL, true));
  }, [value]);

  const mathOpened = mathEdit?.opened;
  useEffect(() => { if (mathOpened) mathInput.current?.focus(); }, [mathOpened]);

  function leave(event: FocusEvent<HTMLDivElement>) {
    if (root.current?.contains(event.relatedTarget as Node | null)) return;
    if (mathEdit) finishMath(mathEdit, false);
    setEditing(false);
    if (dirty.current) { dirty.current = false; live.current.onCommit?.(); }
  }

  // 完成 ends editing wherever the focus is; leaving applies an open formula and saves.
  function finishEditing() {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.current?.contains(focused)) focused.blur();
  }

  function run(command: Command) {
    const view = viewRef.current; if (!view) return;
    command(view.state, view.dispatch, view); view.focus();
  }

  function insertFormula() {
    const view = viewRef.current; if (!view) return;
    const { state } = view; const { selection } = state;
    if (selection instanceof NodeSelection) { if (selection.node.type === math) live.current.openMath(selection.from); return; }
    const latex = selection.empty ? "" : state.doc.textBetween(selection.from, selection.to, " ").trim();
    const original = selection.empty ? null : selection.content();
    view.dispatch(state.tr.replaceSelectionWith(math.create({ latex }), true));
    openMath(selection.from, original ?? Slice.empty);
  }

  const preview = mathEdit?.latex.trim() ? renderKatex(mathEdit.latex) : null;
  return <div ref={root} className={`note-editor${editing ? " editing" : ""}`} onFocus={() => setEditing(true)} onBlur={leave}>
    <div ref={mount} />
    {editing && <div className="note-toolbar" role="toolbar" aria-label={plainText ? `${label}格式` : "知识点格式"} onMouseDown={(event) => event.preventDefault()}>
      {!plainText && <><button type="button" className={tools.heading ? "active" : ""} aria-pressed={tools.heading} disabled={!tools.canHeading} onClick={() => run(toggleHeading)}>小标题</button>
      <button type="button" className={tools.bold ? "active" : ""} aria-pressed={tools.bold} disabled={!tools.canBold} onClick={() => run(toggleBold)}>加粗</button></>}
      <button type="button" disabled={!tools.canFormula} onClick={insertFormula}>公式</button>
      <button type="button" className="note-done" onClick={finishEditing}>完成</button>
    </div>}
    {mathEdit && <div className="note-math-popover" role="dialog" aria-label="编辑公式" style={{ top: mathEdit.top, left: `clamp(0px, ${mathEdit.left}px, calc(100% - min(340px, 100%)))`, transform: mathEdit.above ? "translateY(-100%)" : undefined }}>
      <div className="note-math-preview" aria-live="polite">{!preview
        ? <span className="note-math-hint">输入公式，如 \frac{"{1}{2}"}、\angle A、x^{"{2}"}</span>
        : "error" in preview ? <span className="note-math-error">公式有误，请检查</span>
          : <span className="math-formula inline-math" dangerouslySetInnerHTML={{ __html: preview.html }} />}</div>
      <input ref={mathInput} aria-label="公式（LaTeX）" spellCheck={false} autoComplete="off" value={mathEdit.latex} placeholder="\frac{1}{2}"
        onChange={(event) => setMathEdit({ ...mathEdit, latex: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); finishMath(mathEdit, true); }
          if (event.key === "Escape") { event.preventDefault(); finishMath(mathEdit, true, true); }
        }} />
      <div className="note-math-actions">
        <button type="button" className="text-button" onClick={() => finishMath({ ...mathEdit, latex: "" }, true)}>删除</button>
        <button type="button" className="primary-button" onClick={() => finishMath(mathEdit, true)}>确定</button>
      </div>
    </div>}
  </div>;
}
