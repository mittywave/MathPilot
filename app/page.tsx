"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { DocxContent } from "./components/DocxContent";
import { MathText } from "./components/MathText";
import { StudioSolution } from "./components/StudioSolution";
import { PaperMoreMenu } from "./components/PaperMoreMenu";
import { SiteHeader } from "./components/SiteHeader";
import { WrongQuestionEvidence } from "./components/WrongQuestionEvidence";
import WrongQuestionUpload from "./components/WrongQuestionUpload";
import { QuestionBody } from "./components/QuestionBody";
import { editableQuestionDraft, newQuestionDraft, QuestionEntry } from "./components/QuestionEntry";
import { moveBasketQuestion, orderedBasketQuestions } from "../lib/paper-basket";
import { exportQuestionsToWord } from "../lib/export-word";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../lib/library-tree";
import { authorizeDownload, createCloudCategory, createCloudModule, createStudent as createStudentProfile, deleteCloudCategory, deleteCloudModule, deleteCloudQuestion, deleteStudent as deleteStudentProfile, deleteWrongQuestion, fetchDeletedQuestions, fetchLibrary, fetchMe, fetchStudents, fetchWrongQuestions, importCloudLibrary, login, logout, register, reorderCloudModules, restoreCloudQuestion, restoreWrongQuestion, updateCloudModule, updateStudent as updateStudentProfile } from "../lib/api-client";
import { ALEVEL_PAGE_COPY, ALEVEL_PAGE_LOCALE_KEY, alevelPageLabel, alevelQuestionCount, isAlevel9709ModuleName, localizeAlevelTags, type AlevelPageLocale } from "../lib/alevel-page-locale.mjs";
import { randomClientId } from "../lib/client-random-id.mjs";
import { WRONG_QUESTION_DELETED, type AuthUser, type Category, type LibraryData, type LibraryModule, type Question, type QuestionType, type Student, type StudentSummary, type WrongQuestionEntry } from "../lib/types";

// The sidebar is hidden on phones, so the student picker there also offers creating a student.
const NEW_STUDENT_OPTION = "__new_student__";
const TRASH_HINT = "可在“分类与数据管理”的回收站恢复";
const questionTypes: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];

function uid(prefix: string) { return `${prefix}-${randomClientId()}`; }
function currentTimestamp() { return Date.now(); }

export default function Home() {
  const [alevelPageLocale, setAlevelPageLocale] = useState<AlevelPageLocale>("zh");
  const [modules, setModules] = useState<LibraryModule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeModuleId, setActiveModuleId] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // A student's wrong book is browsed like a library: its question snapshots join the basket pool, so they can be selected and exported.
  const [basketWrongQuestions, setBasketWrongQuestions] = useState<Question[]>([]);
  const [wrongMonth, setWrongMonth] = useState("全部");
  const [wrongUploadOpen, setWrongUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"全部" | QuestionType>("全部");
  const [showSelected, setShowSelected] = useState(false);
  const [expandedAnswers, setExpandedAnswers] = useState<string[]>([]);
  const [entryDraft, setEntryDraft] = useState<Question | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<"new" | "manage" | "trash" | null>(null);
  const [trashQuestions, setTrashQuestions] = useState<Array<Question & { deletedAt: number }> | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState<string>("");
  const [exportDialog, setExportDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [paperTitle, setPaperTitle] = useState("专项练习");
  const [includeAnswers, setIncludeAnswers] = useState(true);
  const [notice, setNotice] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authDialog, setAuthDialog] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authInvite, setAuthInvite] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [moduleDialog, setModuleDialog] = useState<"new" | "manage" | null>(null);
  const [moduleDraft, setModuleDraft] = useState<LibraryModule | null>(null);
  const [moduleName, setModuleName] = useState("");
  const [moduleSubtitle, setModuleSubtitle] = useState("");
  const [draggedModuleId, setDraggedModuleId] = useState("");
  const [deleteModuleTarget, setDeleteModuleTarget] = useState<LibraryModule | null>(null);
  const [deleteModuleConfirmation, setDeleteModuleConfirmation] = useState("");
  const [showWrongBook, setShowWrongBook] = useState(false);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [activeStudentId, setActiveStudentId] = useState("");
  const [wrongEntries, setWrongEntries] = useState<WrongQuestionEntry[]>([]);
  const [wrongBookLoading, setWrongBookLoading] = useState(false);
  const [studentDialog, setStudentDialog] = useState(false);
  const [studentDraft, setStudentDraft] = useState<Student | null>(null);
  const [studentName, setStudentName] = useState("");
  const [studentClassName, setStudentClassName] = useState("");
  const [studentNotes, setStudentNotes] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const activeModule = modules.find((item) => item.id === activeModuleId) ?? modules[0] ?? null;
  const isAlevelPage = !showWrongBook && !showSelected && isAlevel9709ModuleName(activeModule?.name);
  const pageLocale: AlevelPageLocale = isAlevelPage ? alevelPageLocale : "zh";
  const pageCopy = ALEVEL_PAGE_COPY[pageLocale];
  // 机构共用一个题库：登录老师都能录题、改题、建分类；删除只开放给管理员。
  const canManageLibrary = Boolean(authUser);
  const canDelete = authUser?.role === "admin";
  const activeStudent = students.find((item) => item.id === activeStudentId) ?? null;


  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try { setAlevelPageLocale(window.localStorage.getItem(ALEVEL_PAGE_LOCALE_KEY) === "en" ? "en" : "zh"); } catch { /* 本地存储不可用时保持中文默认值 */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function chooseAlevelPageLocale(locale: AlevelPageLocale) {
    setAlevelPageLocale(locale);
    try { window.localStorage.setItem(ALEVEL_PAGE_LOCALE_KEY, locale); } catch { /* 本地存储不可用时仍保留本次切换 */ }
  }

  function applyLibrary(data: LibraryData, preserveCategory = true) {
    const sortedModules = [...data.modules].sort((left, right) => left.sortOrder - right.sortOrder);
    setModules(sortedModules);
    setCategories(data.categories.sort((a, b) => a.createdAt - b.createdAt));
    setQuestions(data.questions.sort((a, b) => b.createdAt - a.createdAt));
    const availableIds = new Set([...sortedModules.map((item) => item.id), ...data.categories.map((item) => item.id)]);
    const nextModule = sortedModules.find((item) => item.id === activeModuleId) ?? sortedModules[0] ?? null;
    setActiveModuleId(nextModule?.id ?? "");
    setActiveCategory((current) => preserveCategory && current && availableIds.has(current) ? current : nextModule?.id ?? null);
    if (nextModule && !selectedIds.length) setPaperTitle(`${nextModule.name}专项练习`);
  }

  async function refreshLibrary(preserveCategory = true) {
    const data = await fetchLibrary();
    applyLibrary(data, preserveCategory);
  }

  useEffect(() => {
    void (async () => {
      try {
        const auth = await fetchMe();
        const params = new URLSearchParams(window.location.search);
        const data = await fetchLibrary();
        setAuthUser(auth.user); applyLibrary(data, false);
        if (auth.user && params.get("view") === "wrong-book") {
          setShowWrongBook(true); setWrongBookLoading(true);
          try { await loadStudents(params.get("studentId") ?? ""); } finally { setWrongBookLoading(false); }
        } else if (auth.user && params.get("view") === "selected") setShowSelected(true);
      } catch { setNotice("云端题库读取失败，请刷新页面重试"); }
      finally { setAuthLoading(false); }
    })();
  // The initial URL view is intentionally read once; later switches are handled by page actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);

  const childrenOf = (id: string | null) => categories.filter((item) => item.parentId === id);
  const descendantsOf = (id: string) => categoryDescendants(categories, id);
  const categoryById = (id: string | null) => categories.find((item) => item.id === id);
  const moduleById = (id: string | null) => modules.find((item) => item.id === id);
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const countFor = (id: string) => moduleById(id)
    ? questions.filter((question) => question.moduleId === id).length
    : questions.filter((question) => descendantsOf(id).includes(question.categoryId)).length;
  const moduleCategories = activeModule ? categories.filter((item) => item.moduleId === activeModule.id) : [];
  const moduleQuestions = activeModule ? questions.filter((item) => item.moduleId === activeModule.id) : [];
  const activeCategoryIds = activeCategory ? descendantsOf(activeCategory) : activeModule ? [activeModule.id, ...moduleCategories.map((item) => item.id)] : [];
  const categoryQuestions = moduleQuestions.filter((item) => activeCategoryIds.includes(item.categoryId));

  function switchExamModule(moduleId: string) {
    const targetModule = modules.find((item) => item.id === moduleId); if (!targetModule) return;
    setActiveModuleId(targetModule.id);
    setActiveCategory(targetModule.id);
    if (!selectedIds.length) setPaperTitle(`${targetModule.name}专项练习`);
    setTypeFilter("全部");
    setQuery("");
    setShowSelected(false);
    setShowWrongBook(false);
  }

  const basketPool = useMemo(() => [...questions, ...basketWrongQuestions], [questions, basketWrongQuestions]);
  const selectedQuestions = orderedBasketQuestions(basketPool, selectedIds);
  const filteredQuestions = useMemo(() => {
    if (showSelected) return orderedBasketQuestions(basketPool, selectedIds);
    let result = questions;
    if (activeCategory) { const allowed = descendantsOf(activeCategory); result = result.filter((item) => allowed.includes(item.categoryId)); }
    if (typeFilter !== "全部") result = result.filter((item) => item.type === typeFilter);
    const keyword = query.trim().toLowerCase();
    if (keyword) result = result.filter((item) => questionMatchesKeyword(item, keyword, pathOf(item.categoryId)));
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, basketPool, categories, activeCategory, showSelected, typeFilter, query, selectedIds]);

  const activeName = showSelected ? "我的组卷" : activeCategory ? moduleById(activeCategory)?.name ?? categoryById(activeCategory)?.name ?? pageCopy.allQuestions : pageCopy.allQuestions;
  const activeWrongEntries = wrongEntries.filter(entry => entry.archivedAt == null);
  const historicalWrongEntries = wrongEntries.filter(entry => entry.archivedAt != null);
  const filteredWrongEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return wrongEntries.filter(entry => entry.archivedAt == null);
    return wrongEntries.filter(entry => entry.archivedAt == null).filter((entry) => `${entry.question.stem} ${entry.question.answer} ${entry.question.analysis} ${entry.question.source} ${entry.sourcePath}`.toLowerCase().includes(keyword));
  }, [query, wrongEntries]);
  // Wrong questions are filed by the month they were last got wrong, newest month first.
  const wrongMonthOf = (entry: WrongQuestionEntry) => { const date = new Date(entry.lastWrongAt); return `${date.getFullYear()}年${date.getMonth() + 1}月`; };
  const wrongMonths = [...new Set([...activeWrongEntries].sort((a, b) => b.lastWrongAt - a.lastWrongAt).map(wrongMonthOf))];
  const activeWrongMonth = wrongMonths.includes(wrongMonth) ? wrongMonth : "全部";
  const visibleWrongMonths = wrongMonths.filter((month) => activeWrongMonth === "全部" || month === activeWrongMonth)
    .map((month) => ({ month, entries: filteredWrongEntries.filter((entry) => wrongMonthOf(entry) === month) })).filter((group) => group.entries.length);
  const selectedWrongEntries = activeWrongEntries.filter((entry) => selectedIds.includes(entry.question.id));
  const selectableIds = showWrongBook ? visibleWrongMonths.flatMap((group) => group.entries.map((entry) => entry.question.id)) : filteredQuestions.map((item) => item.id);

  const allFilteredSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));

  function showWrongEntries(entries: WrongQuestionEntry[]) {
    setWrongEntries(entries);
    const snapshots = entries.filter((entry) => entry.archivedAt == null).map((entry) => entry.question);
    setBasketWrongQuestions((current) => [...current.filter((item) => !snapshots.some((question) => question.id === item.id)), ...snapshots]);
  }

  const requireLogin = () => { if (authUser) return true; setAuthMode("login"); setAuthDialog(true); setAuthError("请先登录后再使用这项功能"); return false; };
  function openLibrary() {
    setShowSelected(false); setShowWrongBook(false);
  }

  async function loadStudents(preferredStudentId = activeStudentId) {
    const result = await fetchStudents();
    setStudents(result.students);
    const nextId = result.students.some((item) => item.id === preferredStudentId) ? preferredStudentId : result.students[0]?.id ?? "";
    setActiveStudentId(nextId);
    if (nextId) {
      const wrong = await fetchWrongQuestions(nextId);
      showWrongEntries(wrong.entries);
    } else showWrongEntries([]);
    return result.students;
  }

  async function openWrongBook() {
    if (!requireLogin()) return;
    setShowWrongBook(true); setShowSelected(false); setQuery(""); setWrongMonth("全部"); setWrongBookLoading(true);
    try { await loadStudents(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "错题本读取失败"); }
    finally { setWrongBookLoading(false); }
  }

  async function selectStudent(id: string) {
    setActiveStudentId(id); setWrongBookLoading(true); setQuery(""); setWrongMonth("全部");
    try { showWrongEntries((await fetchWrongQuestions(id)).entries); }
    catch (error) { setNotice(error instanceof Error ? error.message : "错题记录读取失败"); }
    finally { setWrongBookLoading(false); }
  }

  function openStudentDialog(student?: Student) {
    setStudentDraft(student ?? null); setStudentName(student?.name ?? ""); setStudentClassName(student?.className ?? ""); setStudentNotes(student?.notes ?? ""); setStudentDialog(true);
  }

  async function saveStudent() {
    if (!studentName.trim()) { setNotice("请填写学生姓名或昵称"); return; }
    try {
      const payload = { name: studentName, className: studentClassName, notes: studentNotes };
      const result = studentDraft
        ? await updateStudentProfile({ ...studentDraft, ...payload })
        : await createStudentProfile(payload);
      setStudentDialog(false); await loadStudents(result.student.id);
      setNotice(studentDraft ? "学生档案已更新" : `已创建学生档案：${result.student.name}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "学生档案保存失败"); }
  }

  async function removeStudent(student: StudentSummary) {
    if (!window.confirm(`删除“${student.name}”及其 ${student.wrongCount} 道错题记录？此操作无法撤销。`)) return;
    try {
      await deleteStudentProfile(student.id); await loadStudents(activeStudentId === student.id ? "" : activeStudentId);
      setNotice(`已删除学生档案：${student.name}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "学生档案删除失败"); }
  }

  const toggleSelected = (id: string) => { if (!requireLogin()) return; setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); };
  const toggleAllFiltered = () => {
    if (!requireLogin()) return;
    setSelectedIds((current) => allFilteredSelected ? current.filter((id) => !selectableIds.includes(id)) : [...current, ...selectableIds.filter((id) => !current.includes(id))]);
  };
  const openNewQuestion = () => { if (!requireLogin() || !canManageLibrary) return; if (!activeModule) { setModuleDialog("new"); return; } setEntryDraft(newQuestionDraft(activeModule, activeCategory ?? activeModule.id)); };
  const openEditQuestion = (question: Question) => { if (!requireLogin() || !question.canEdit) { setNotice("当前题库为只读"); return; } const questionModule = modules.find((item) => item.id === question.moduleId); if (questionModule && questionModule.id !== activeModuleId) { setActiveModuleId(questionModule.id); setPaperTitle(`${questionModule.name}专项练习`); setActiveCategory(question.categoryId); } setEntryDraft(editableQuestionDraft(question, questionModule)); };

  async function submitAuth() {
    setAuthSubmitting(true); setAuthError("");
    try {
      const result = authMode === "register" ? await register(authEmail, authPassword, authInvite) : await login(authEmail, authPassword);
      setAuthUser(result.user); setAuthDialog(false); setAuthPassword(""); setAuthInvite(""); await refreshLibrary(true);
      setNotice(authMode === "register" ? "注册成功，已登录云端题库" : "登录成功");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setAuthSubmitting(false); }
  }

  async function signOut() {
    try { await logout(); setAuthUser(null); setSelectedIds([]); setShowSelected(false); setShowWrongBook(false); setStudents([]); setWrongEntries([]); await refreshLibrary(false); setNotice("已退出登录，当前为访客浏览"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "退出失败"); }
  }

  async function deleteQuestion(question: Question) {
    try { await deleteCloudQuestion(question.id); setQuestions((current) => current.filter((item) => item.id !== question.id)); setSelectedIds((current) => current.filter((id) => id !== question.id)); setNotice(`试题已删除，${TRASH_HINT}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除失败"); }
  }

  async function deleteWrongEntries(entries: WrongQuestionEntry[]) {
    try {
      await Promise.all(entries.map((entry) => deleteWrongQuestion(entry.studentId, entry.id)));
      const ids = entries.map((entry) => entry.question.id);
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      await loadStudents(entries[0].studentId); setNotice(`已删除 ${entries.length} 道错题，可在页面底部“历史记录”恢复`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "错题删除失败"); }
  }

  async function restoreWrongEntry(entry: WrongQuestionEntry) {
    try { await restoreWrongQuestion(entry.studentId, entry.id); await loadStudents(entry.studentId); setNotice("错题已恢复"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "错题恢复失败"); }
  }

  async function deleteSelectedQuestions() {
    const ids = selectedIds.filter((id) => questions.some((item) => item.id === id));
    if (!ids.length) return;
    const editableIds = ids.filter((id) => questions.find((item) => item.id === id)?.canEdit);
    if (!editableIds.length) { setNotice("所选题目中没有你可以删除的内容"); return; }
    try {
      await Promise.all(editableIds.map((id) => deleteCloudQuestion(id)));
      setQuestions((current) => current.filter((item) => !editableIds.includes(item.id)));
      setExpandedAnswers((current) => current.filter((id) => !editableIds.includes(id)));
      setSelectedIds((current) => current.filter((id) => !editableIds.includes(id))); setNotice(`已删除 ${editableIds.length} 道试题，${TRASH_HINT}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "批量删除失败"); }
  }

  async function createCategory() {
    if (!categoryName.trim() || !activeModule) { setNotice("请填写分类名称"); return; }
    const category: Category = { id: uid("cat"), name: categoryName.trim(), moduleId: activeModule.id, parentId: categoryParent || activeModule.id, createdAt: currentTimestamp() };
    try { const result = await createCloudCategory(category); setCategories((current) => [...current, result.category]); setCategoryName(""); setCategoryDialog(null); setActiveCategory(result.category.id); setNotice("分类已创建"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "分类创建失败"); }
  }

  async function openTrash() {
    setCategoryDialog("trash"); setTrashQuestions(null);
    try { setTrashQuestions((await fetchDeletedQuestions()).questions); }
    catch (error) { setNotice(error instanceof Error ? error.message : "回收站读取失败"); }
  }

  async function restoreQuestion(question: Question) {
    try { await restoreCloudQuestion(question.id); setTrashQuestions((current) => current?.filter((item) => item.id !== question.id) ?? null); await refreshLibrary(); setNotice("试题已恢复"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "恢复失败"); }
  }

  async function deleteCategory(category: Category) {
    const categoryIds = descendantsOf(category.id); const questionIds = questions.filter((item) => categoryIds.includes(item.categoryId)).map((item) => item.id);
    if (!window.confirm(`删除“${category.name}”及其子分类？其中 ${questionIds.length} 道试题会移入回收站。`)) return;
    try { await deleteCloudCategory(category.id); setCategories((current) => current.filter((item) => !categoryIds.includes(item.id))); setQuestions((current) => current.filter((item) => !questionIds.includes(item.id))); setSelectedIds((current) => current.filter((id) => !questionIds.includes(id))); setActiveCategory(activeModule?.id ?? null); setNotice("分类已删除"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "分类删除失败"); }
  }

  function exportBackup() {
    const data: LibraryData = { scope: "public", modules, categories, questions };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `Mitty题库备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("备份文件已导出");
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const data = JSON.parse(await file.text()) as LibraryData; if (!Array.isArray(data.categories) || !Array.isArray(data.questions)) throw new Error("bad shape"); if (!window.confirm("导入后会把备份中的模块、分类和题目追加到当前题库，是否继续？")) return; const result = await importCloudLibrary(data); await refreshLibrary(false); setSelectedIds([]); setCategoryDialog(null); setNotice(`已迁移 ${result.imported} 道题到当前题库`); } catch (error) { setNotice(error instanceof Error ? error.message : "无法识别这个备份文件"); } finally { event.target.value = ""; }
  }

  async function generateWord() {
    if (!selectedQuestions.length || isExporting) return;
    setIsExporting(true);
    try { await authorizeDownload(selectedQuestions.map((question) => question.id)); await exportQuestionsToWord(selectedQuestions, paperTitle.trim() || "练习题", includeAnswers, "basket"); setExportDialog(false); setNotice("Word 练习已生成"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "下载失败"); }
    finally { setIsExporting(false); }
  }

  function openNewModule() {
    if (!requireLogin() || !canManageLibrary) return;
    setModuleDraft(null); setModuleName(""); setModuleSubtitle(""); setModuleDialog("new");
  }

  function openModuleEditor(module: LibraryModule) {
    setModuleDraft(module); setModuleName(module.name); setModuleSubtitle(module.subtitle); setModuleDialog("new");
  }

  async function saveModule() {
    if (!moduleName.trim()) { setNotice("请填写模块名称"); return; }
    try {
      if (moduleDraft) {
        const result = await updateCloudModule({ ...moduleDraft, name: moduleName.trim(), subtitle: moduleSubtitle.trim() });
        setModules((current) => current.map((item) => item.id === result.module.id ? result.module : item));
        if (activeModuleId === result.module.id) setPaperTitle(`${result.module.name}专项练习`);
        setNotice("模块已更新");
      } else {
        const result = await createCloudModule({ name: moduleName.trim(), subtitle: moduleSubtitle.trim() });
        setModules((current) => [...current, result.module]); setActiveModuleId(result.module.id); setActiveCategory(result.module.id); setPaperTitle(`${result.module.name}专项练习`);
        setNotice("模块已创建");
      }
      setModuleDialog(null); setModuleDraft(null); setModuleName(""); setModuleSubtitle("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "模块保存失败"); }
  }

  async function moveModule(id: string, direction: -1 | 1) {
    const index = modules.findIndex((item) => item.id === id); const target = index + direction;
    if (index < 0 || target < 0 || target >= modules.length) return;
    const next = [...modules]; [next[index], next[target]] = [next[target], next[index]];
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder }));
    setModules(ordered);
    try { await reorderCloudModules(ordered.map((item) => item.id)); }
    catch (error) { await refreshLibrary(true); setNotice(error instanceof Error ? error.message : "模块排序失败"); }
  }

  async function dropModule(targetId: string) {
    if (!draggedModuleId || draggedModuleId === targetId) { setDraggedModuleId(""); return; }
    const source = modules.find((item) => item.id === draggedModuleId); const targetIndex = modules.findIndex((item) => item.id === targetId);
    if (!source || targetIndex < 0) return;
    const next = modules.filter((item) => item.id !== draggedModuleId); next.splice(targetIndex, 0, source);
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder })); setModules(ordered); setDraggedModuleId("");
    try { await reorderCloudModules(ordered.map((item) => item.id)); }
    catch (error) { await refreshLibrary(true); setNotice(error instanceof Error ? error.message : "模块排序失败"); }
  }

  async function confirmDeleteModule() {
    if (!deleteModuleTarget) return;
    try {
      await deleteCloudModule(deleteModuleTarget.id, deleteModuleConfirmation);
      const removedId = deleteModuleTarget.id;
      const next = modules.filter((item) => item.id !== removedId);
      const removedQuestions = questions.filter((item) => item.moduleId === removedId).map((item) => item.id);
      setModules(next); setCategories((current) => current.filter((item) => item.moduleId !== removedId)); setQuestions((current) => current.filter((item) => item.moduleId !== removedId));
      setSelectedIds((current) => current.filter((id) => !removedQuestions.includes(id)));
      setDeleteModuleTarget(null); setDeleteModuleConfirmation(""); setModuleDialog(null);
      setActiveModuleId(next[0]?.id ?? ""); setActiveCategory(next[0]?.id ?? null); if (next[0]) setPaperTitle(`${next[0].name}专项练习`);
      setNotice("模块及其内容已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : "模块删除失败"); }
  }

  function renderTree(parentId: string | null, depth = 0) {
    return childrenOf(parentId).map((category) => (
      <div key={category.id}>
        <button className={`tree-row ${activeCategory === category.id && !showSelected ? "active-leaf" : ""}`} style={{ paddingLeft: 10 + depth * 17 }} onClick={() => { setActiveCategory(category.id); setShowSelected(false); }}>
          <span className="tree-dot">{childrenOf(category.id).length ? "◆" : "·"}</span><span className="tree-name">{category.name}</span><span className="count">{countFor(category.id)}</span>
        </button>
        {renderTree(category.id, depth + 1)}
      </div>
    ));
  }

  function renderModuleTree() {
    if (!activeModule) return <p className="empty-tree">请先创建一个模块</p>;
    return <>
      <button className={`tree-row module-root ${activeCategory === activeModule.id && !showSelected ? "active-leaf" : ""}`} onClick={() => { setActiveCategory(activeModule.id); setShowSelected(false); }}>
        <span className="tree-dot">◆</span><span className="tree-name">{activeModule.name}</span><span className="count">{countFor(activeModule.id)}</span>
      </button>
      {renderTree(activeModule.id, 1)}
    </>;
  }

  return (
    <main className={`app-shell ${isAlevelPage ? `alevel-page locale-${pageLocale}` : ""}`.trim()}>
      <SiteHeader active={showWrongBook ? "students" : showSelected ? "basket" : "library"} user={authUser} loading={authLoading} locale={pageLocale} basketCount={selectedIds.length}
        onSelect={(section) => { if (section === "library") openLibrary(); else if (section === "students") void openWrongBook(); else { setShowWrongBook(false); setShowSelected(true); } }}
        actions={authUser ? <>{!authUser.local && <button className="account-button" onClick={signOut}>{pageCopy.signOut}</button>}{canManageLibrary && !showWrongBook && !showSelected && <button className="primary-button" onClick={openNewQuestion} disabled={!activeModule}><span>＋</span> {pageCopy.newQuestion}</button>}</> : <><span className="guest-badge">{pageCopy.guestBrowse}</span><button className="account-button" onClick={() => { setAuthMode("login"); setAuthError(""); setAuthDialog(true); }}>{pageCopy.loginRegister}</button></>} />

      <section className={`workspace ${showSelected && !showWrongBook ? "basket-workspace" : ""}`}>
        {(!showSelected || showWrongBook) && <aside className="sidebar">
          {showWrongBook ? <>
            <div className="sidebar-heading"><div><span className="eyebrow">学生专属空间</span><h2>学生档案</h2></div><button className="icon-button" aria-label="新建学生" title="新建学生" onClick={() => openStudentDialog()}>＋</button></div>
            <div className="student-list">{students.length ? students.map((student) => <button key={student.id} className={`student-card ${student.id === activeStudentId ? "active" : ""}`} onClick={() => selectStudent(student.id)}><span>{student.name.slice(0, 1)}</span><div><b>{student.name}</b><small>{student.className || "未填写班级"}</small></div><em>{student.wrongCount}</em></button>) : <div className="student-list-empty"><span>人</span><b>还没有学生档案</b><p>先创建学生，再上传他的已完成作业。</p></div>}</div>
            <button className="manage-button" onClick={() => openStudentDialog()}>＋ 新建学生档案</button>
            {activeStudent && <div className="student-profile-actions"><button onClick={() => openStudentDialog(activeStudent)}>编辑档案</button><button className="danger-text" onClick={() => removeStudent(activeStudent)}>删除</button></div>}
          </> : <>
          <div className="sidebar-heading"><div><span className="eyebrow">{activeModule?.name ?? pageCopy.publicLibrary}</span><h2>{pageCopy.knowledgeDirectory}</h2></div>{canManageLibrary && activeModule && <button className="icon-button" aria-label={pageCopy.addCategory} title={pageCopy.addCategory} onClick={() => { setCategoryParent(activeCategory ?? activeModule.id); setCategoryDialog("new"); }}>＋</button>}</div>
          <div className="tree">{renderModuleTree()}</div>
          {canManageLibrary ? <button className="manage-button" onClick={() => setCategoryDialog("manage")} disabled={!activeModule}>{pageCopy.manageCategories}</button> : <button className="manage-button" onClick={() => { setAuthMode("login"); setAuthDialog(true); }}>{pageCopy.loginToDownload}</button>}
          </>}
        </aside>}

        <section className="content">
          {showWrongBook ? <>
            <div className="student-archive-heading"><h1>学生档案</h1></div>
            <div className="library-context-bar wrong-book-context"><div><b>学生专属错题本</b><span>不同学生的错题和错误次数彼此独立</span></div></div>
            {!!students.length && <label className="mobile-student-picker"><span>当前学生</span><select value={activeStudentId} onChange={(event) => { if (event.target.value === NEW_STUDENT_OPTION) openStudentDialog(); else selectStudent(event.target.value); }}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.wrongCount} 道错题</option>)}<option value={NEW_STUDENT_OPTION}>＋ 新建学生</option></select></label>}
            {activeStudent ? <>
              <div className="wrong-book-hero"><div className="student-avatar">{activeStudent.name.slice(0, 1)}</div><div><p className="breadcrumb">{activeStudent.className || "未填写班级"}</p><h1>{activeStudent.name}的错题本</h1><p className="subtext">{activeStudent.notes || "按月记录作业中完全错误的题目"}</p></div><div className="wrong-book-stats"><span><b>{activeStudent.wrongCount}</b>全部错题</span></div></div>
              <div className="content-head wrong-book-head"><div><p className="breadcrumb">学习记录</p><h2>{activeWrongEntries.length ? "作业错题清单" : "开始建立错题本"}</h2><p className="subtext">上传学生作业自动批改，完全错误的题目按月收录，可加入组卷篮导出。</p>{!!activeWrongEntries.length && <button className="wrong-upload-link" onClick={() => setWrongUploadOpen(true)}>＋ 新建错题</button>}</div><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索学生错题" placeholder="搜索题干或来源…" /></label></div>
              {!!activeWrongEntries.length && <div className="filters">
                <button className={`filter ${activeWrongMonth === "全部" ? "active" : ""}`} onClick={() => setWrongMonth("全部")}>全部 <span>{activeWrongEntries.length}</span></button>
                {wrongMonths.map((month) => <button key={month} className={`filter ${activeWrongMonth === month ? "active" : ""}`} onClick={() => setWrongMonth(month)}>{month} <span>{activeWrongEntries.filter((entry) => wrongMonthOf(entry) === month).length}</span></button>)}
                <button className={`select-visible ${allFilteredSelected ? "active" : ""}`} disabled={!selectableIds.length} onClick={toggleAllFiltered}>{allFilteredSelected ? "取消选中" : "选中结果"}</button>
              </div>}
              <div className="question-list wrong-question-list">
                {wrongBookLoading ? <div className="wrong-book-loading"><i></i><span>正在读取错题记录…</span></div> : !filteredWrongEntries.length ? <div className="empty-state"><div>错</div><h3>{activeWrongEntries.length ? "没有符合搜索的错题" : "还没有错题记录"}</h3><p>{activeWrongEntries.length ? "换一个关键词继续查找" : "上传学生作业，批改后自动收录错题"}</p>{!activeWrongEntries.length && <button className="wrong-upload-link" onClick={() => setWrongUploadOpen(true)}>＋ 新建错题</button>}</div> : visibleWrongMonths.map((group) => <section className="wrong-month" key={group.month} aria-label={`${group.month}错题`}>
                  <h3 className="wrong-month-head">{group.month}<span>{group.entries.length} 题</span></h3>
                  {group.entries.map((entry, index) => {
                  const question = entry.question; const answerKey = `wrong-${entry.id}`; const answerOpen = expandedAnswers.includes(answerKey); const checked = selectedIds.includes(question.id);
                  return <article className={`question-card wrong-question-card ${checked ? "checked" : ""}`} key={entry.id}>
                    <button className={`check ${checked ? "on" : ""}`} aria-label={`${checked ? "取消选择" : "选择"}${group.month}第 ${index + 1} 题`} onClick={() => toggleSelected(question.id)}>{checked ? "✓" : ""}</button>
                    <div className="question-main">
                      <div className="meta"><span>{question.type}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{question.difficulty}</span><span className="wrong-count-badge">错 {entry.mistakeCount} 次</span><em>{entry.sourcePath}</em></div>
                      <QuestionBody question={question} number={index + 1} figureAlt="错题配图" />
                      <WrongQuestionEvidence entry={entry} />
                      {answerOpen && <div className="answer-box"><b>答案</b><p><MathText text={question.answer || "略"} /></p>{question.analysis && <><b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                      <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(answerKey) ? current.filter((id) => id !== answerKey) : [...current, answerKey])}>{answerOpen ? "收起解析" : "查看解析"}</button><small>最近记录 {new Date(entry.lastWrongAt).toLocaleDateString("zh-CN")}</small><span></span><button className="danger-text" onClick={() => deleteWrongEntries([entry])}>删除</button></div>
                    </div>
                  </article>;
                })}</section>)}
              </div>
              {!!historicalWrongEntries.length && <details className="wrong-history"><summary>历史记录（{historicalWrongEntries.length}）</summary><p>删除、部分正确及已修正的记录保留在此，不计入当前错题统计；删除的错题可以恢复。</p>{historicalWrongEntries.map(entry => <article key={entry.id}><b>{entry.sourcePath}</b><p><MathText text={entry.question.stem} /></p><small>{entry.archiveReason}</small>{entry.archiveReason === WRONG_QUESTION_DELETED && <button className="secondary" onClick={() => restoreWrongEntry(entry)}>恢复</button>}<WrongQuestionEvidence entry={entry} /></article>)}</details>}
            </> : <div className="empty-state wrong-book-empty"><div>人</div><h3>{wrongBookLoading ? "正在读取学生档案" : "为第一位学生建立错题本"}</h3><p>每位学生都有独立的错题和错误次数。</p><button onClick={() => openStudentDialog()}>＋ 新建学生档案</button></div>}
          </> : <>
          {showSelected ? <>
            <div className="basket-heading">
              <div><p className="breadcrumb">选题完成后，在这里整理练习</p><h1>组卷篮 <span>{selectedQuestions.length} 题</span></h1><p className="subtext">题目按下方顺序生成 Word，可随时继续选题。</p></div>
              {!!selectedQuestions.length && <button className="secondary" onClick={() => setShowSelected(false)}>继续选题</button>}
            </div>
            {!!selectedQuestions.length && <>
              <div className="basket-settings">
                <label className="basket-title">练习标题<input value={paperTitle} disabled={isExporting} onChange={(event) => setPaperTitle(event.target.value)} placeholder="输入练习标题" /></label>
                <label className="basket-answer" htmlFor="basket-include-answers" aria-label="附带答案与解析"><input id="basket-include-answers" type="checkbox" checked={includeAnswers} disabled={isExporting} onChange={(event) => setIncludeAnswers(event.target.checked)} /><span><b>附带答案与解析</b><small>在练习题末尾另起一页</small></span></label>
              </div>
              <div className="basket-toolbar"><span>已选 {selectedQuestions.length} 题 · 上移或下移调整顺序</span><PaperMoreMenu><button disabled={isExporting} onClick={() => setSelectedIds([])}>清空组卷篮</button></PaperMoreMenu><button className="primary-button" disabled={isExporting} onClick={generateWord}>{isExporting ? "正在生成…" : "生成 Word"}</button></div>
            </>}
          </> : <>
          <div className="library-context-bar"><div><b>{pageCopy.publicLibrary}</b><span>{authUser ? pageCopy.publicMemberAccess : pageCopy.publicGuestAccess}</span></div>{canManageLibrary && <button className="secondary" onClick={() => setModuleDialog("manage")}>{pageCopy.manageModules}</button>}</div>
          <div className="module-switcher" aria-label={pageCopy.moduleSwitcher}>
            {modules.map((examModule, index) => <button key={examModule.id} className={activeModule?.id === examModule.id && !showSelected ? "active" : ""} onClick={() => switchExamModule(examModule.id)}>
              <span>{String(index + 1).padStart(2, "0")}</span><div><b>{examModule.name}</b><small>{examModule.subtitle || pageCopy.noSubtitle}</small></div><em>{pageLocale === "en" ? alevelQuestionCount(countFor(examModule.id), pageLocale) : `${countFor(examModule.id)} ${pageCopy.questionUnit}`}</em>
            </button>)}
            {canManageLibrary && <button className="module-add" onClick={openNewModule}><span>＋</span><div><b>{pageCopy.newModule}</b><small>{pageCopy.customModule}</small></div></button>}
          </div>
          <div className="content-head">
            <div><p className="breadcrumb">{showSelected ? "当前题库组卷篮" : activeCategory ? pathOf(activeCategory) : activeModule?.name ?? "尚无模块"}</p><h1>{activeName}</h1><p className="subtext">{alevelQuestionCount(filteredQuestions.length, pageLocale)} · {showSelected ? "可跨当前题库的模块组卷" : activeModule ? `${activeModule.name} ${pageCopy.moduleSuffix}` : "创建第一个模块后开始录题"}{authUser ? authUser.local ? ` · ${pageCopy.localAdminSuffix}` : ` · ${pageCopy.loggedInAs} ${authUser.role === "admin" ? pageCopy.admin : pageCopy.member}` : ` · ${pageCopy.guestSuffix}`}</p></div>
            <div className="content-head-actions">{isAlevelPage && <div className="page-language-switch" role="group" aria-label={pageCopy.language}><button lang="zh-CN" className={alevelPageLocale === "zh" ? "active" : ""} aria-pressed={alevelPageLocale === "zh"} onClick={() => chooseAlevelPageLocale("zh")}>中文</button><button lang="en" className={alevelPageLocale === "en" ? "active" : ""} aria-pressed={alevelPageLocale === "en"} onClick={() => chooseAlevelPageLocale("en")}>English</button></div>}<label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={pageCopy.searchLabel} placeholder={pageCopy.searchPlaceholder} /></label></div>
          </div>
          <div className="filters">
            <button className={`filter ${typeFilter === "全部" ? "active" : ""}`} onClick={() => setTypeFilter("全部")}>{pageCopy.allTypes} <span>{showSelected ? selectedQuestions.length : categoryQuestions.length}</span></button>
            {questionTypes.map((type) => <button key={type} className={`filter ${typeFilter === type ? "active" : ""}`} onClick={() => setTypeFilter(type)}>{pageLocale === "en" ? alevelPageLabel(type, pageLocale) : type.replace("单选题", "选择题")} <span>{(showSelected ? selectedQuestions : categoryQuestions).filter((item) => item.type === type).length}</span></button>)}
            {authUser && <button className={`select-visible ${allFilteredSelected ? "active" : ""}`} disabled={!filteredQuestions.length} onClick={toggleAllFiltered}>{allFilteredSelected ? pageCopy.clearSelection : pageCopy.selectResults}</button>}
          </div>
          </>}
          <div className="question-list">
            {!filteredQuestions.length && <div className={`empty-state ${showSelected ? "basket-empty" : ""}`}><div>{pageCopy.empty}</div><h3>{showSelected ? "组卷篮还是空的" : !activeModule ? "创建第一个模块" : `${activeModule.name}${pageLocale === "en" ? " " : ""}${pageCopy.noQuestions}`}</h3><p>{showSelected ? "到题库勾选题目或从学生错题本加入，再回来调整顺序并生成练习。" : !activeModule ? canManageLibrary ? "模块可以是考试、学科或你习惯的任意分组" : "登录后即可创建模块和录题" : canManageLibrary ? pageCopy.addFirstQuestion : pageCopy.noResources}</p>{showSelected ? <button onClick={() => setShowSelected(false)}>去题库选题</button> : canManageLibrary ? <button onClick={activeModule ? openNewQuestion : openNewModule}>{activeModule ? pageCopy.newQuestion : pageCopy.newModule}</button> : null}</div>}
            {filteredQuestions.map((question, index) => {
              const checked = selectedIds.includes(question.id); const answerOpen = expandedAnswers.includes(question.id); const visibleTags = isAlevelPage ? localizeAlevelTags(question, pageLocale) : question.tags ?? [];
              return <article className={`question-card ${checked ? "checked" : ""}`} key={question.id}>
                {authUser && !showSelected && <button className={`check ${checked ? "on" : ""}`} aria-label={pageLocale === "en" ? `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion} question ${index + 1}` : `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion}第 ${index + 1} 题`} onClick={() => toggleSelected(question.id)}>{checked ? "✓" : ""}</button>}
                <div className="question-main">
                  <div className="meta"><span>{alevelPageLabel(question.type, pageLocale)}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{alevelPageLabel(question.difficulty, pageLocale)}</span><em>{pathOf(question.categoryId) || question.source}</em></div>
                  <QuestionBody question={question} number={index + 1} figureAlt={pageCopy.figureAlt} />
                  {!!visibleTags.length && <div className="tag-row">{visibleTags.map((tag) => <span key={`${pageLocale}-${tag}`}>{tag}</span>)}</div>}
                  {answerOpen && <div className="answer-box"><b>{pageCopy.answer}</b><p><MathText text={question.answer || pageCopy.none} /></p>{question.analysis && <><b>{pageCopy.solution}</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                  <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(question.id) ? current.filter((id) => id !== question.id) : [...current, question.id])}>{answerOpen ? pageCopy.hideSolution : pageCopy.showSolution}</button>{question.createdByEmail && <small>{pageCopy.enteredBy} {question.createdByEmail}{pageCopy.enteredSuffix ? ` ${pageCopy.enteredSuffix}` : ""}</small>}<span></span>{!showSelected && question.canEdit && <><button onClick={() => openEditQuestion(question)}>{pageCopy.edit}</button>{canDelete && <button className="danger-text" onClick={() => deleteQuestion(question)}>{pageCopy.delete}</button>}</>}{showSelected && <div className="basket-card-actions"><button disabled={index === 0 || isExporting} aria-label={`上移第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => moveBasketQuestion(ids, question.id, -1))}>↑ 上移</button><button disabled={index === filteredQuestions.length - 1 || isExporting} aria-label={`下移第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => moveBasketQuestion(ids, question.id, 1))}>↓ 下移</button><button disabled={isExporting} aria-label={`移除第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => ids.filter((id) => id !== question.id))}>移除</button></div>}</div>
                </div>
              </article>;
            })}
          </div>
          </>}
        </section>
      </section>

      {authUser && !showSelected && !!selectedQuestions.length && <aside className="paper-dock visible"><div className="dock-count"><strong>{selectedQuestions.length}</strong><span>已选试题</span></div><div className="dock-title"><b>选好题目后，进入组卷篮整理</b></div>{showWrongBook ? !!selectedWrongEntries.length && <button className="dock-delete-button" onClick={() => deleteWrongEntries(selectedWrongEntries)}>删除</button> : canDelete && <button className="dock-delete-button" onClick={deleteSelectedQuestions}>删除</button>}<button className="export-button" onClick={() => { setShowWrongBook(false); setShowSelected(true); }}>整理组卷 <span>→</span></button></aside>}

      {entryDraft && <QuestionEntry initial={entryDraft} modules={modules} categories={categories} moduleIds={[entryDraft.moduleId || activeModule?.id || ""]} onClose={() => setEntryDraft(null)} onNotice={setNotice} onSaved={(saved) => setQuestions((current) => [...saved, ...current.filter((item) => !saved.some((entry) => entry.id === item.id))].sort((a, b) => b.createdAt - a.createdAt))} />}

      {categoryDialog && activeModule && <div className="modal-backdrop"><section className="modal category-modal" role="dialog" aria-modal="true" aria-label="分类管理">
        <div className="modal-head"><div><span className="eyebrow">{activeModule.name}</span><h2>{categoryDialog === "new" ? "新建模块内分类" : categoryDialog === "trash" ? "回收站" : "分类与数据管理"}</h2></div><button className="close" onClick={() => setCategoryDialog(null)}>×</button></div>
        {categoryDialog === "new" ? <>
          <label className="field">分类名称<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：二次函数" /></label>
          <label className="field">上级分类<select value={categoryParent || activeModule.id} onChange={(event) => setCategoryParent(event.target.value)}><option value={activeModule.id}>{activeModule.name}（模块根目录）</option>{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setCategoryDialog(null)}>取消</button><button className="primary-button" onClick={createCategory}>创建分类</button></div>
        </> : categoryDialog === "trash" ? <>
          <div className="manage-list trash-list">{!trashQuestions ? <p className="empty-tree">正在读取回收站…</p> : trashQuestions.some((item) => item.moduleId === activeModule.id) ? trashQuestions.filter((item) => item.moduleId === activeModule.id).map((item) => <div key={item.id}><span><b><MathText text={item.stem.split("\n")[0]} /></b><small>{pathOf(item.categoryId) || `${activeModule.name}（原分类已删除，恢复到模块根目录）`} · {new Date(item.deletedAt).toLocaleDateString("zh-CN")} 删除</small></span><button onClick={() => restoreQuestion(item)}>恢复</button></div>) : <p className="empty-tree">回收站是空的</p>}</div>
          <div className="modal-actions"><button className="secondary" onClick={() => setCategoryDialog("manage")}>返回</button><button className="primary-button" onClick={() => setCategoryDialog(null)}>完成</button></div>
        </> : <>
          <div className="manage-list">{moduleCategories.length ? moduleCategories.map((item) => <div key={item.id}><span><b>{item.name}</b><small>{pathOf(item.id)} · {countFor(item.id)} 题</small></span>{canDelete && <button onClick={() => deleteCategory(item)}>删除</button>}</div>) : <p className="empty-tree">当前模块还没有子分类</p>}</div>
          <div className="data-tools"><div><b>题库备份</b><small>备份包含动态模块、分类和题目；导入会追加到当前题库。</small></div><button className="secondary" onClick={() => importRef.current?.click()}>导入备份</button><button className="secondary" onClick={exportBackup}>导出备份</button><input ref={importRef} type="file" accept="application/json" hidden onChange={importBackup} /></div>
          {canDelete && <div className="data-tools"><div><b>回收站</b><small>删除的试题保留在这里，可恢复到原分类。</small></div><button className="secondary" onClick={openTrash}>打开</button></div>}
          <div className="modal-actions"><button className="secondary" onClick={() => { setCategoryParent(activeCategory ?? activeModule.id); setCategoryDialog("new"); }}>＋ 新建分类</button><button className="primary-button" onClick={() => setCategoryDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {moduleDialog && <div className="modal-backdrop"><section className="modal module-modal" role="dialog" aria-modal="true" aria-label="模块管理">
        <div className="modal-head"><div><span className="eyebrow">{pageCopy.publicLibrary}</span><h2>{moduleDialog === "new" ? moduleDraft ? "编辑模块" : "新建模块" : "模块管理"}</h2></div><button className="close" onClick={() => { setModuleDialog(null); setModuleDraft(null); }}>×</button></div>
        {moduleDialog === "new" ? <>
          <label className="field">模块名称<input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="例如：深圳中考" /></label>
          <label className="field">副标题<input value={moduleSubtitle} onChange={(event) => setModuleSubtitle(event.target.value)} placeholder="例如：数学真题与专题训练" /></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setModuleDialog(moduleDraft ? "manage" : null)}>取消</button><button className="primary-button" onClick={saveModule}>{moduleDraft ? "保存修改" : "创建模块"}</button></div>
        </> : <>
          <div className="module-manage-list">{modules.map((item, index) => <div key={item.id} draggable onDragStart={() => setDraggedModuleId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropModule(item.id)}>
            <span className="drag-handle" title="拖动排序">⋮⋮</span><span><b>{item.name}</b><small>{item.subtitle || "未设置副标题"} · {countFor(item.id)} 题</small></span><div><button title="上移" aria-label={`上移${item.name}`} disabled={index === 0} onClick={() => moveModule(item.id, -1)}>↑</button><button title="下移" aria-label={`下移${item.name}`} disabled={index === modules.length - 1} onClick={() => moveModule(item.id, 1)}>↓</button><button onClick={() => openModuleEditor(item)}>编辑</button>{canDelete && <button className="danger-text" onClick={() => { setDeleteModuleTarget(item); setDeleteModuleConfirmation(""); }}>删除</button>}</div>
          </div>)}</div>
          <div className="modal-actions"><button className="secondary" onClick={openNewModule}>＋ 新建模块</button><button className="primary-button" onClick={() => setModuleDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {deleteModuleTarget && <div className="modal-backdrop modal-backdrop-raised"><section className="modal delete-modal" role="dialog" aria-modal="true" aria-label="删除模块">
        <div className="modal-head"><div><span className="eyebrow">危险操作</span><h2>删除“{deleteModuleTarget.name}”</h2></div><button className="close" onClick={() => setDeleteModuleTarget(null)}>×</button></div>
        <div className="delete-summary"><strong>{questions.filter((item) => item.moduleId === deleteModuleTarget.id).length}</strong><div><b>道题及 {categories.filter((item) => item.moduleId === deleteModuleTarget.id).length} 个分类将一并删除</b><p>该操作无法撤销。请输入完整模块名称确认。</p></div></div>
        <label className="field">输入“{deleteModuleTarget.name}”<input value={deleteModuleConfirmation} onChange={(event) => setDeleteModuleConfirmation(event.target.value)} /></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setDeleteModuleTarget(null)}>取消</button><button className="danger-button" disabled={deleteModuleConfirmation !== deleteModuleTarget.name} onClick={confirmDeleteModule}>确认删除</button></div>
      </section></div>}

      {studentDialog && <div className="modal-backdrop"><section className="modal student-modal" role="dialog" aria-modal="true" aria-label={studentDraft ? "编辑学生档案" : "新建学生档案"}>
        <div className="modal-head"><div><span className="eyebrow">学生专属空间</span><h2>{studentDraft ? "编辑学生档案" : "新建学生档案"}</h2></div><button className="close" onClick={() => setStudentDialog(false)}>×</button></div>
        <label className="field">学生姓名或昵称<input value={studentName} onChange={(event) => setStudentName(event.target.value)} placeholder="例如：小宇" /></label>
        <label className="field">班级 / 年级（选填）<input value={studentClassName} onChange={(event) => setStudentClassName(event.target.value)} placeholder="例如：初三（2）班" /></label>
        <label className="field">学习备注（选填）<textarea rows={4} value={studentNotes} onChange={(event) => setStudentNotes(event.target.value)} placeholder="例如：几何基础较好，函数综合题需要加强" /></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setStudentDialog(false)}>取消</button><button className="primary-button" onClick={saveStudent}>{studentDraft ? "保存档案" : "创建学生"}</button></div>
      </section></div>}

      {wrongUploadOpen && activeStudent && <WrongQuestionUpload student={activeStudent} onClose={() => setWrongUploadOpen(false)} onGraded={(submission) => { void loadStudents(submission.studentId); if (submission.status !== "published") return; const archived = submission.gradingSummary?.archived ?? 0; setWrongUploadOpen(false); setNotice(archived ? `已收录 ${archived} 道错题` : "批改完成，没有需要收录的错题"); }} />}

      {exportDialog && <div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="生成 Word"><div className="modal-head"><div><span className="eyebrow">Word 组卷</span><h2>生成练习题</h2></div><button className="close" onClick={() => setExportDialog(false)}>×</button></div><div className="export-summary"><strong>{selectedIds.length}</strong><span>道试题将按组卷篮顺序排入文档</span></div><label className="field">练习标题<input value={paperTitle} onChange={(event) => setPaperTitle(event.target.value)} /></label><label className="toggle-row" aria-label="答案设置"><input type="checkbox" checked={includeAnswers} onChange={(event) => setIncludeAnswers(event.target.checked)} /><span><b>附带答案与解析</b><small>在练习题末尾另起一页</small></span></label><div className="modal-actions"><button className="secondary" onClick={() => setExportDialog(false)}>取消</button><button className="primary-button" disabled={isExporting} onClick={generateWord}>{isExporting ? "正在生成…" : "下载 .docx"}</button></div></section></div>}

      {authDialog && <div className="modal-backdrop"><section className="modal auth-modal" role="dialog" aria-modal="true" aria-label={authMode === "login" ? "登录" : "注册"}>
        <div className="modal-head"><div><span className="eyebrow">Mitty 云端题库</span><h2>{authMode === "login" ? "邮箱登录" : "使用邀请码注册"}</h2></div><button className="close" onClick={() => setAuthDialog(false)}>×</button></div>
        <div className="auth-tabs"><button className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>登录</button><button className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); setAuthError(""); }}>注册</button></div>
        <label className="field">邮箱<input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label className="field">密码<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="至少 8 个字符" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>
        {authMode === "register" && <label className="field">邀请码<input value={authInvite} onChange={(event) => setAuthInvite(event.target.value)} placeholder="请输入管理员提供的邀请码" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>}
        {authError && <div className="recognition-error"><b>{authMode === "login" ? "登录未完成" : "注册未完成"}</b><span>{authError}</span></div>}
        <p className="auth-note">访客无需登录即可浏览题目；注册后可以录题、组卷和下载 Word。普通会员只能修改自己录入的题目。</p>
        <div className="modal-actions"><button className="secondary" onClick={() => setAuthDialog(false)}>取消</button><button className="primary-button" disabled={authSubmitting || !authEmail || !authPassword || (authMode === "register" && !authInvite)} onClick={submitAuth}>{authSubmitting ? "请稍候…" : authMode === "login" ? "登录" : "注册并登录"}</button></div>
      </section></div>}
      {notice && <div className="toast">✓ {notice}</div>}
    </main>
  );
}
