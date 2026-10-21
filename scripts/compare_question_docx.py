#!/usr/bin/env python3
"""Compare a source question DOCX with a DOCX exported by the question bank."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from xml.etree import ElementTree as ET


ANSWER_TITLE = re.compile(r"参考答案与试题解析|答案与解析|试题解析")
SECTION_TITLE = re.compile(r"^[一二三四五六七八九十]+[.．、].*(选择题|填空题|判断题|解答题|证明题|计算题|综合与实践)")
QUESTION_START = re.compile(r"^\s*(\d{1,3})[.．、]\s*(.*)$", re.S)
ANALYSIS_START = re.compile(r"^【(?:分析|解答|点评)】")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def element_text(element: ET.Element) -> str:
    values = [node.text or "" for node in element.iter() if local_name(node.tag) == "t"]
    return "".join(values).strip()


def normalize(value: str) -> str:
    value = re.sub(r"^\s*\d{1,3}[.．、]\s*", "", value)
    return re.sub(r"[\s\u3000，。；：,.!?！？（）()【】“”‘’．、]", "", value)


@dataclass
class Block:
    kind: str
    text: str
    math_count: int
    image_ids: set[str]


@dataclass
class DocumentData:
    blocks: list[Block]
    media_hashes: set[str]


def read_docx(path: Path) -> DocumentData:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        body = next(node for node in root.iter() if local_name(node.tag) == "body")
        blocks: list[Block] = []
        for node in body:
            kind = local_name(node.tag)
            if kind not in {"p", "tbl"}:
                continue
            image_ids = {
                value
                for child in node.iter()
                for key, value in child.attrib.items()
                if local_name(key) in {"embed", "link"}
            }
            blocks.append(Block(
                kind=kind,
                text=element_text(node),
                math_count=sum(1 for child in node.iter() if local_name(child.tag) == "oMath"),
                image_ids=image_ids,
            ))
        media_hashes = {
            hashlib.sha256(archive.read(name)).hexdigest()
            for name in archive.namelist()
            if (name.startswith("word/media/") or name.startswith("media/")) and not name.endswith("/")
        }
    return DocumentData(blocks=blocks, media_hashes=media_hashes)


def split_at_answers(blocks: list[Block]) -> tuple[list[Block], list[Block]]:
    index = next((index for index, block in enumerate(blocks) if ANSWER_TITLE.search(block.text)), len(blocks))
    return blocks[:index], blocks[index + 1 :]


def question_groups(blocks: list[Block]) -> dict[str, list[Block]]:
    groups: dict[str, list[Block]] = {}
    current: str | None = None
    for block in blocks:
        if SECTION_TITLE.search(block.text):
            current = None
            continue
        match = QUESTION_START.match(block.text) if block.kind == "p" else None
        if match:
            current = match.group(1)
            groups[current] = [block]
        elif current and (block.text or block.kind == "tbl" or block.image_ids):
            groups[current].append(block)
    return groups


def analysis_groups(blocks: list[Block]) -> dict[str, list[Block]]:
    groups: dict[str, list[Block]] = {}
    current: str | None = None
    collecting = False
    for block in blocks:
        match = QUESTION_START.match(block.text) if block.kind == "p" else None
        if match:
            current = match.group(1)
            collecting = False
            continue
        if ANALYSIS_START.match(block.text):
            collecting = True
        if current and collecting and (block.text or block.kind == "tbl" or block.image_ids):
            groups.setdefault(current, []).append(block)
    return groups


def group_text(blocks: list[Block]) -> str:
    return normalize("\n".join(block.text for block in blocks))


def average_similarity(source: dict[str, list[Block]], exported: dict[str, list[Block]]) -> tuple[float, dict[str, float]]:
    scores: dict[str, float] = {}
    for number, blocks in source.items():
        expected = group_text(blocks)
        actual = group_text(exported.get(number, []))
        scores[number] = SequenceMatcher(None, expected, actual).ratio() if expected else (1.0 if not actual else 0.0)
    return (sum(scores.values()) / len(scores) if scores else 1.0), scores


def structural_counts(groups: dict[str, list[Block]]) -> tuple[int, int, int]:
    blocks = [block for values in groups.values() for block in values]
    return (
        sum(block.math_count for block in blocks),
        sum(1 for block in blocks if block.kind == "tbl"),
        len({image_id for block in blocks for image_id in block.image_ids}),
    )


def retention_score(source_count: int, exported_count: int) -> float:
    if source_count == 0:
        return 1.0
    return min(source_count, exported_count) / source_count


def compare(source_path: Path, exported_path: Path) -> dict[str, object]:
    source = read_docx(source_path)
    exported = read_docx(exported_path)
    source_questions_part, source_answers_part = split_at_answers(source.blocks)
    exported_questions_part, exported_answers_part = split_at_answers(exported.blocks)
    source_questions = question_groups(source_questions_part)
    exported_questions = question_groups(exported_questions_part)
    source_analyses = analysis_groups(source_answers_part)
    exported_analyses = analysis_groups(exported_answers_part)
    question_similarity, question_scores = average_similarity(source_questions, exported_questions)
    analysis_similarity, analysis_scores = average_similarity(source_analyses, exported_analyses)
    source_math_q, source_tables_q, source_images_q = structural_counts(source_questions)
    source_math_a, source_tables_a, source_images_a = structural_counts(source_analyses)
    export_math_q, export_tables_q, export_images_q = structural_counts(exported_questions)
    export_math_a, export_tables_a, export_images_a = structural_counts(exported_analyses)
    source_math = source_math_q + source_math_a
    export_math = export_math_q + export_math_a
    source_tables = source_tables_q + source_tables_a
    export_tables = export_tables_q + export_tables_a
    count_score = retention_score(len(source_questions), len(exported_questions))
    formula_score = retention_score(source_math, export_math)
    table_score = retention_score(source_tables, export_tables)
    total = 20 * count_score + 40 * question_similarity + 25 * analysis_similarity + 10 * formula_score + 5 * table_score
    weak_questions = {number: round(score * 100, 2) for number, score in question_scores.items() if score < 0.9}
    weak_analyses = {number: round(score * 100, 2) for number, score in analysis_scores.items() if score < 0.9}
    return {
        "score": round(total, 2),
        "question_count": [len(exported_questions), len(source_questions)],
        "question_similarity": round(question_similarity * 100, 2),
        "analysis_count": [len(exported_analyses), len(source_analyses)],
        "analysis_similarity": round(analysis_similarity * 100, 2),
        "omml_formulas": [export_math, source_math],
        "tables": [export_tables, source_tables],
        "referenced_images": [export_images_q + export_images_a, source_images_q + source_images_a],
        "media_files": [len(exported.media_hashes), len(source.media_hashes)],
        "matching_media_files": len(exported.media_hashes & source.media_hashes),
        "weak_questions": weak_questions,
        "weak_analyses": weak_analyses,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("exported", type=Path)
    parser.add_argument("--threshold", type=float, default=90.0)
    args = parser.parse_args()
    result = compare(args.source, args.exported)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if float(result["score"]) < args.threshold:
        print(f"完成度 {result['score']}% 低于阈值 {args.threshold}%", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
