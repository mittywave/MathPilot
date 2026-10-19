% mitty-handout.cls — 讲义编撰的精排版式。生成器只输出语义命令，版式全部集中在这里。
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{mitty-handout}[2026/10/01 Mitty handout]
\LoadClass[UTF8,zihao=5,fontset=none,scheme=chinese]{ctexart}

\RequirePackage[a4paper,left=19mm,right=19mm,top=24mm,bottom=22mm,headheight=16pt,headsep=7mm,footskip=11mm]{geometry}
\RequirePackage{amsmath}
\RequirePackage{unicode-math}
\RequirePackage{graphicx,xcolor,colortbl,array,tabularx,multirow,needspace}
\RequirePackage[normalem]{ulem}
\RequirePackage[most]{tcolorbox}
\RequirePackage{tikz}
\RequirePackage{fancyhdr}
\RequirePackage{lastpage}

% ---- 字体：macOS 系统字体优先，其他环境退回 TeX 自带的 Fandol ----
\IfFontExistsTF{STSongti-SC-Regular}
  {\setCJKmainfont{STSongti-SC-Regular}[BoldFont=STSongti-SC-Bold]}
  {\setCJKmainfont{FandolSong-Regular.otf}[BoldFont=FandolSong-Bold.otf]}
\IfFontExistsTF{HiraginoSansGB-W3}
  {\setCJKsansfont{HiraginoSansGB-W3}[BoldFont=HiraginoSansGB-W6]
   \setsansfont{HiraginoSansGB-W3}[BoldFont=HiraginoSansGB-W6]}
  {\setCJKsansfont{FandolHei-Regular.otf}[BoldFont=FandolHei-Bold.otf]}
\IfFontExistsTF{STKaitiSC-Regular}
  {\setCJKfamilyfont{mhkai}{STKaitiSC-Regular}[BoldFont=STKaitiSC-Bold]}
  {\setCJKfamilyfont{mhkai}{FandolKai-Regular.otf}}
\setmainfont{STIXTwoText}[Extension=.otf,UprightFont=*-Regular,BoldFont=*-Bold,ItalicFont=*-Italic,BoldItalicFont=*-BoldItalic]
\setmathfont{STIXTwoMath-Regular.otf}
% 圈码①…⑳由中文字体排印；省略号…按中文字符断行，后面的“，”不会被挤到下一行开头
\xeCJKDeclareCharClass{CJK}{"2460->"2473,"2026}
\newcommand\mhkai{\CJKfamily{mhkai}}

% ---- 配色：一个品牌绿 + 中性色，黑白打印同样清楚 ----
\definecolor{mhgreen}{HTML}{2F6B53}
\definecolor{mhdeep}{HTML}{1E4A3A}
\definecolor{mhtint}{HTML}{F2F7F4}
\definecolor{mhwash}{HTML}{E3EEE7}
\definecolor{mhline}{HTML}{CFDDD5}
\definecolor{mhink}{HTML}{1D2622}
\definecolor{mhmuted}{HTML}{6F7D76}
\color{mhink}

\setlength\parindent{0pt}
\setlength\parskip{0pt}
\linespread{1.08}
\setlength\emergencystretch{2em}
\renewcommand\arraystretch{1.45}
\tcbset{before skip=0pt,after skip=0pt}

% ---- 标题信息 ----
\newcommand\mh@series{}\newcommand\mh@title{}\newcommand\mh@edition{}\newcommand\mh@fields{姓名,班级,日期}\newcommand\mh@brand{Mitty 讲义}
\newcommand\handoutseries[1]{\renewcommand\mh@series{#1}}
\newcommand\handouttitle[1]{\renewcommand\mh@title{#1}}
\newcommand\handoutedition[1]{\renewcommand\mh@edition{#1}}
\newcommand\handoutfields[1]{\renewcommand\mh@fields{#1}}
\newcommand\handoutbrand[1]{\renewcommand\mh@brand{#1}}

\newcommand\mh@field[1]{{\sffamily\color{mhmuted}#1}\enspace\textcolor{mhline}{\rule[-0.35ex]{26mm}{0.6pt}}}
\newcommand\mh@pill[2]{\tikz[baseline=(t.base)]\node[inner xsep=2.2mm,inner ysep=1.1mm,rounded corners=1.6mm,fill=#1,text=white,font=\sffamily\bfseries\small](t){#2};}
\newcommand\mh@outlinepill[1]{\tikz[baseline=(t.base)]\node[inner xsep=2mm,inner ysep=0.9mm,rounded corners=1.6mm,draw=mhgreen,line width=0.6pt,text=mhgreen,font=\sffamily\small](t){#1};}

% 标题区：浅底圆角卡片，右侧一组极淡的几何线稿作为数学讲义的标识
\newcommand\makehandouttitle{%
  \begin{tcolorbox}[enhanced,colback=mhtint,colframe=mhtint,boxrule=0pt,arc=3.5mm,
    left=7mm,right=7mm,top=6mm,bottom=5.5mm,
    underlay={\begin{scope}[shift={([xshift=-34mm,yshift=-3mm]frame.east)},line width=0.7pt,draw=mhgreen,opacity=0.18]
      \draw (0,0) circle (12mm);
      \draw (-10.4mm,-6mm) -- (10.4mm,-6mm) -- (0,12mm) -- cycle;
      \draw[dashed] (0,12mm) -- (0,-6mm);
      \fill[mhgreen] (0,12mm) circle (0.8mm) (10.4mm,-6mm) circle (0.8mm) (-10.4mm,-6mm) circle (0.8mm);
    \end{scope}}]
    \ifx\mh@series\empty\else\mh@pill{mhgreen}{\mh@series}\fi\hfill
    \ifx\mh@edition\empty\else\mh@outlinepill{\mh@edition}\fi\par\vspace{3.4mm}
    {\sffamily\bfseries\fontsize{21pt}{27pt}\selectfont\color{mhdeep}\mh@title\par}
    \vspace{2.4mm}{\color{mhgreen}\rule{14mm}{1.6pt}}\par
    \vspace{4.2mm}
    {\small\def\mh@sep{}\@for\mh@item:=\mh@fields\do{\mh@sep\mh@field{\mh@item}\def\mh@sep{\hspace{7mm}}}\par}
  \end{tcolorbox}\par\vspace{4mm}}

% ---- 页眉页脚：首页无页眉；之后显示标题和本页最先出现的分节（本页没有新分节就沿用上一页的） ----
\fancypagestyle{mhpage}{\fancyhf{}%
  \fancyhead[L]{\sffamily\footnotesize\color{mhmuted}\mh@title}%
  \fancyhead[R]{\sffamily\footnotesize\color{mhmuted}\rightmark}%
  \fancyfoot[L]{\sffamily\scriptsize\color{mhmuted}\mh@brand}%
  \fancyfoot[R]{\sffamily\footnotesize{\color{mhgreen}\bfseries\thepage}\,{\color{mhmuted}/\,\pageref{LastPage}}}%
  \renewcommand\headrule{{\color{mhline}\hrule height 0.5pt}}\renewcommand\footrule{}}
\fancypagestyle{mhfirst}{\fancyhf{}%
  \fancyfoot[L]{\sffamily\scriptsize\color{mhmuted}\mh@brand}%
  \fancyfoot[R]{\sffamily\footnotesize{\color{mhgreen}\bfseries\thepage}\,{\color{mhmuted}/\,\pageref{LastPage}}}%
  \renewcommand\headrule{}\renewcommand\footrule{}}
\pagestyle{mhpage}
\AtBeginDocument{\thispagestyle{mhfirst}}

% ---- 分页：标题总和下面的内容在同一页；一道题放得进一页就不拆开 ----
% 题目和答案条目先整条排进盒子：不超过给定高度就整条放上页面，更长的照常分页（开头不断开）。
% 标题之后不留断页点，放不下时标题随下面的内容一起移到下一页。
\newif\ifmh@afterhead
\newbox\mh@unit
\newcommand\mh@unitstart{\setbox\mh@unit\vbox\bgroup\@nobreaktrue}
\newcommand\mh@keep[1]{\egroup\ifdim\dimexpr\ht\mh@unit+\dp\mh@unit\relax>#1\unvbox\mh@unit\else\box\mh@unit\fi\global\mh@afterheadfalse}
\newcommand\mh@headbreak[1]{\par\ifmh@afterhead\nobreak\else\needspace{#1}\fi}

% ---- 作答横线：1 行 = \mh@linepitch（默认 8mm，\handoutlinepitch 可改）。每条线在一行的底边，行距不受行高影响 ----
\newlength\mh@linepitch\setlength\mh@linepitch{8mm}
\newcommand\handoutlinepitch[1]{\setlength\mh@linepitch{#1}}
\newcount\mh@linecount
\newcommand\mh@ruled[2]{\nointerlineskip\moveright#1\vbox to\mh@linepitch{\vfil\hbox{\textcolor{mhline}{\rule{#2}{0.45pt}}}}}
\newcommand\mh@rules[1]{\par\mh@linecount=#1\relax\@whilenum\mh@linecount>\z@\do{\mh@ruled{\@totalleftmargin}{\linewidth}\advance\mh@linecount\m@ne}}
% 页底：本页最后一块是印了作答横线的题时，按同样的行距、缩进和宽度把横线画到版心底边。
% 每道题结束时在独立的 mark 类里记下它的横线（没有横线记空），分节、段标签、文末答案的标题也记空，
% 所以 \botmarks 就是本页最后一块的情况。分页先由 TeX 定好，横线只补在页底剩下的地方，不改分页。
\newmarks\mh@roommark
\newdimen\mh@room
\newif\ifmh@lines
\def\mh@lineshape{}
% 页尾的空白、罚点（如 needspace 留在页底的 \vskip）不算内容：量高度、补横线之前都先去掉，横线紧接着题目的最后一条线。
\def\mh@striptail{\ifcase\numexpr\lastnodetype-10\relax\or\unskip\expandafter\mh@striptail\or\unkern\expandafter\mh@striptail
  \or\unpenalty\expandafter\mh@striptail\fi}
\def\@texttop{\setbox\@tempboxa\vbox{\unvcopy\@outputbox\mh@striptail}%
  \global\mh@room\dimexpr\@colht-\ht\@tempboxa-\dp\@tempboxa\relax}
\def\@textbottom{\expandafter\mh@fillroom\botmarks\mh@roommark::\@nil\vskip\z@\@plus.0001fil}
\def\mh@fillroom#1:#2:#3\@nil{\ifx\relax#1\relax\else\mh@striptail
  \mh@linecount\mh@room\divide\mh@linecount\mh@linepitch
  \@whilenum\mh@linecount>\z@\do{\mh@ruled{#1}{#2}\advance\mh@linecount\m@ne}%
  \vskip\z@\@plus1fill\fi}

% ---- 分节：老师写了序号就做成圆角徽标，没写就用一道色条，不替老师编号 ----
% 留够分节标题、知识点标签和至少两行知识点的位置
\newcommand\handoutsection[2]{%
  \par\needspace{8\baselineskip}\vspace{6mm}%
  \noindent\markright{\unexpanded{#2}}\ifx\relax#1\relax\tikz[baseline=-0.7ex]\fill[mhgreen,rounded corners=0.8mm](0,-2.6mm) rectangle (1.8mm,2.6mm);%
  \else\tikz[baseline=(b.base)]\node[fill=mhgreen,rounded corners=1.6mm,minimum width=7mm,minimum height=7mm,inner sep=0pt,text=white,font=\sffamily\bfseries](b){#1};\fi%
  \hspace{2.6mm}{\sffamily\bfseries\large\color{mhdeep}#2}\hspace{3mm}%
  \leaders\hbox{\textcolor{mhline}{\rule[0.55ex]{1pt}{0.6pt}}}\hfill\null\par\marks\mh@roommark{}\nobreak\vspace{3.2mm}\global\mh@afterheadtrue}

% ---- 分天的练习（智能组卷）：第二天起另起一页；天名用分节的样式，下面一行留日期、用时和做对几题 ----
\newcounter{mhgroup}
\newcommand\handoutgroup[2]{%
  \ifnum\value{mhgroup}>0 \clearpage\fi\stepcounter{mhgroup}%
  \handoutsection{\arabic{mhgroup}}{#1}\vspace{-1.6mm}%
  \noindent{\sffamily\footnotesize\color{mhmuted}日期\enspace\rule[-0.4mm]{20mm}{0.4pt}\qquad 用时\enspace\rule[-0.4mm]{14mm}{0.4pt}\qquad 做对\enspace\rule[-0.4mm]{9mm}{0.4pt}\,/\,#2 题\par}%
  \marks\mh@roommark{}\nobreak\vspace{2.6mm}\global\mh@afterheadtrue}

% ---- 模块里的四段：知识点 / 例题 / 练习 / 变式。同一种小标签，靠文字区分，不靠颜色堆叠 ----
\newcommand\handoutpart[2]{%
  \mh@headbreak{6\baselineskip}\vspace{4.4mm}%
  \noindent\tikz[baseline=(p.base)]\node[fill=mhwash,rounded corners=1.4mm,inner xsep=2.2mm,inner ysep=1.1mm,font=\sffamily\bfseries\small,text=mhdeep](p){#1};%
  \hspace{2.4mm}{\sffamily\footnotesize\color{mhmuted}#2}\par\marks\mh@roommark{}\nobreak\vspace{1.6mm}\global\mh@afterheadtrue}
% 题号栏按本段最长的编号（例12 / 12 / 变式12）定宽，所有题干对齐
\newcommand\handoutnumberwidth[1]{\settowidth\mh@numwidth{\sffamily\bfseries #1}\addtolength\mh@numwidth{2.8mm}\ifdim\mh@numwidth<7mm\setlength\mh@numwidth{7mm}\fi}

% ---- 分节说明：左侧色条的浅底卡片，楷体更像老师的板书 ----
\newtcolorbox{handoutnote}{enhanced,breakable,colback=mhtint,colframe=mhtint,boxrule=0pt,arc=2mm,
  left=5mm,right=4mm,top=3mm,bottom=3mm,
  borderline west={2pt}{0pt}{mhgreen},
  fontupper=\mhkai\linespread{1.15}\selectfont,before upper={\global\mh@afterheadfalse\parskip=1.2mm}}
% 知识点里的三级标题、要点（序号悬挂，换行对齐正文）
\newcommand\handoutnoteheading[2][2]{\par\ifcase#1\or
  \vspace{.6mm}{\sffamily\bfseries\large\color{mhdeep}#2}\par\vspace{.4mm}\or
  {\sffamily\bfseries\color{mhdeep}#2}\par\or
  {\sffamily\bfseries\small\color{mhgreen}#2}\par\fi}
\newcommand\handoutnoteitem[2]{\par\setbox0\hbox{{\sffamily\bfseries\color{mhgreen}#1}\enspace}\hangindent=\wd0\hangafter=1\noindent\box0 #2\par}
% 一排并排的配图：每张图下面是图注，这排图旁边可以有一段说明（宽度和图高由生成器按张数给出）
\newenvironment{handoutfigurerow}{\par\vspace{1.4mm}\noindent\begin{minipage}{\linewidth}\raggedright}{\end{minipage}\par\vspace{1.4mm}}
\newcommand\handoutrowfigure[4]{\begin{minipage}[c]{#1}\centering
  \parbox[c][#2][c]{\linewidth}{\centering\includegraphics[width=\linewidth,height=#2,keepaspectratio]{#3}}%
  \if\relax\detokenize{#4}\relax\else\par\vspace{1mm}{\small #4\par}\fi\end{minipage}}
\newcommand\handoutrowside[2]{\begin{minipage}[c]{#1}\raggedright\linespread{1.25}\selectfont
  \abovedisplayskip=2pt\belowdisplayskip=2pt\abovedisplayshortskip=0pt\belowdisplayshortskip=2pt #2\par\end{minipage}}

% ---- 题目：悬挂题号，所有行对齐题干 ----
% 每道题的题号处有一个 PDF 目标 q1、q2…（按出现顺序），快速排版的预览据此找到每道题。
% xdvipdfmx 默认删掉没有被链接引用的目标，C 0x0010 让它保留。
\newlength\mh@numwidth\setlength\mh@numwidth{7mm}
\newcounter{mhquestion}
\AtBeginDocument{\special{dvipdfmx:config C 0x0010}}
\newcommand\mh@anchor{\stepcounter{mhquestion}\special{pdf:dest (q\arabic{mhquestion}) [@thispage /XYZ @xpos @ypos null]}}
\newenvironment{handoutquestion}[1]{%
  \mh@headbreak{4\baselineskip}\vspace{3.6mm}\global\mh@linesfalse\mh@unitstart
  \begin{list}{}{\setlength\leftmargin{\mh@numwidth}\setlength\labelwidth{\mh@numwidth}\setlength\labelsep{0pt}%
    \setlength\itemsep{0pt}\setlength\topsep{0pt}\setlength\parsep{1.4mm}\setlength\listparindent{0pt}}%
  \item[{\makebox[\mh@numwidth][l]{\mh@anchor\sffamily\bfseries\color{mhgreen}#1}}]\ignorespaces}
  {\end{list}\mh@keep\textheight\marks\mh@roommark{\ifmh@lines\mh@lineshape\fi}}
% 题后留白（毫米）：排在题目里，和题目一起换页
\newcommand\handoutgap[1]{\par\vspace{#1mm}}
\newcommand\handoutsource[1]{\mbox{\sffamily\footnotesize\color{mhmuted}\tikz[baseline=(s.base)]\node[draw=mhline,line width=0.5pt,rounded corners=1.2mm,inner xsep=1.4mm,inner ysep=0.6mm](s){#1};}\enspace}
% 填空横线：一行放不下时最多缩短四成，不伸出版心；换到行首时 \hspace* 不会像普通空白那样被丢掉
\newcommand\handoutblank[1]{\uline{\hspace*{#1 minus \dimexpr#1*4/10\relax}}}
% 考点：题库里这道题自带的知识点标签
\newcommand\handoutpoints[1]{\par\vspace{0.4mm}{\sffamily\footnotesize\color{mhmuted}考点\enspace #1\par}}
% 学生版例题：跟着老师记思路和步骤的笔记区
\newcommand\handoutnotesarea[1]{\par\vspace{1.6mm}%
  \begin{tcolorbox}[enhanced,colback=white,colframe=mhline,boxrule=0.5pt,arc=2mm,left=4mm,right=4mm,top=2mm,bottom=3mm]
    {\sffamily\scriptsize\color{mhmuted}课堂笔记}{\@totalleftmargin\z@\mh@rules{#1}}
  \end{tcolorbox}}

% 选项：按长度分 4、2、1 栏；标签用品牌绿无衬线
\newcommand\mh@choicelabel[1]{{\sffamily\bfseries\color{mhgreen}#1}\enspace}
\newcommand\handoutchoice[2]{\mh@choicelabel{#1}#2}
\newenvironment{handoutchoices}[1]{%
  \par\vspace{-0.6mm}\setlength\tabcolsep{0pt}\renewcommand\arraystretch{1.2}%
  \noindent\tabularx{\linewidth}{@{}*{#1}{>{\raggedright\arraybackslash}X}@{}}}
  {\endtabularx\par}

% 作答区：几条极淡的横线，给学生留出书写空间；本页最后一道题的横线会延伸到页底。
% 作答区总在题目最后：去掉列表结尾的 \partopsep，最后一条横线就是题目的下沿，延伸的横线紧接着按同样行距排。
\newcommand\handoutworkspace[1]{\par\vspace{2mm}\mh@rules{#1}\@topsepadd\z@
  \xdef\mh@lineshape{\the\@totalleftmargin:\the\linewidth}\global\mh@linestrue}

% 配图（可选参数是最大高度）；题干右侧配图默认占三分之一行宽，截图题按原图所占的比例
\newcommand\handoutfigure[3][46mm]{\includegraphics[width=#2,height=#1,keepaspectratio]{#3}}
\newenvironment{handoutsidefigure}[2][.32]{%
  \def\mh@figurefile{#2}\def\mh@figureshare{#1}\par\noindent\begin{minipage}[t]{\dimexpr.96\linewidth-#1\linewidth\relax}}
  {\end{minipage}\hfill\begin{minipage}[t]{\mh@figureshare\linewidth}\vspace{0pt}\raggedleft
    \handoutfigure{\linewidth}{\mh@figurefile}\end{minipage}\par}
% 原卷里的一行配图：原尺寸、原对齐，排在原来的两段之间；整行比版心宽时等比缩到版心宽
\newsavebox\mh@figrow
\newcommand\handoutfigureline[2]{\par\vspace{1mm}\sbox\mh@figrow{#2}%
  \ifdim\wd\mh@figrow>\linewidth\sbox\mh@figrow{\resizebox{\linewidth}{!}{\usebox\mh@figrow}}\fi
  \noindent\makebox[\linewidth][#1]{\usebox\mh@figrow}\par\vspace{1mm}}
\newcommand\handoutfigures[1]{\par\vspace{2mm}{\centering #1\par}\vspace{1mm}}
\newcommand\handoutfiguresright[1]{\par\vspace{2mm}{\raggedleft #1\par}\vspace{1mm}}

% 表格：浅色网格，首行淡底
\newcommand\handouttablerule{\arrayrulecolor{mhline}}
\newcommand\handoutheadrow{\rowcolor{mhtint}}

% ---- 教师版：紧跟题目的答案卡，与题干对齐；答案长时可以接着排到下一页 ----
\newcommand\mh@tag[1]{\tikz[baseline=(t.base)]\node[fill=mhwash,rounded corners=1.2mm,inner xsep=1.6mm,inner ysep=0.8mm,font=\sffamily\bfseries\footnotesize,text=mhdeep](t){#1};}
\newtcolorbox{handoutanswer}{enhanced,breakable,colback=white,colframe=mhline,boxrule=0.6pt,arc=2mm,
  left=4mm,right=4mm,top=2.6mm,bottom=2.6mm,before skip=2.4mm,left skip=\mh@numwidth,
  before upper={\parskip=1.4mm}}
% 标签固定宽度，换行后的文字与首行文字对齐
\newlength\mh@tagwidth\setlength\mh@tagwidth{10.5mm}
\newcommand\mh@tagged[2]{\begin{list}{}{\setlength\leftmargin{\mh@tagwidth}\setlength\labelwidth{\mh@tagwidth}\setlength\labelsep{0pt}%
    \setlength\topsep{0.7mm}\setlength\partopsep{0pt}\setlength\parsep{0.8mm}\setlength\itemsep{0pt}}%
  % Long inline fraction chains need stretchable right space to choose a legal operator break.
  \raggedright\item[{\makebox[\mh@tagwidth][l]{\mh@tag{#1}}}]#2\end{list}}
\newcommand\handoutanswerline[1]{\mh@tagged{答案}{{\bfseries #1}}}
\newcommand\handoutanalysis[2]{\mh@tagged{#1}{#2}}

% ---- 文末答案 ----
\newcommand\handoutanswerkey{\clearpage
  \noindent\markright{参考答案与解析}\tikz[baseline=(b.base)]\node[fill=mhgreen,rounded corners=1.6mm,minimum width=7mm,minimum height=7mm,inner sep=0pt,text=white,font=\sffamily\bfseries](b){答};%
  \hspace{2.6mm}{\sffamily\bfseries\large\color{mhdeep}参考答案与解析}\hspace{3mm}%
  \leaders\hbox{\textcolor{mhline}{\rule[0.55ex]{1pt}{0.6pt}}}\hfill\null\par\marks\mh@roommark{}\nobreak\vspace{3mm}\global\mh@afterheadtrue}
\newcommand\handoutkeygroup[2]{\mh@headbreak{4\baselineskip}\vspace{4.4mm}\noindent{\sffamily\bfseries\color{mhdeep}#1}\par\marks\mh@roommark{}\nobreak\vspace{0.6mm}\handoutnumberwidth{#2}\global\mh@afterheadtrue}
% 短的答案条目整条不拆，长的解析可以接着排到下一页
\newenvironment{handoutkey}[1]{%
  \mh@headbreak{3\baselineskip}\vspace{2.6mm}\mh@unitstart
  \begin{list}{}{\setlength\leftmargin{\mh@numwidth}\setlength\labelwidth{\mh@numwidth}\setlength\labelsep{0pt}%
    \setlength\itemsep{0pt}\setlength\topsep{0pt}\setlength\parsep{1.2mm}}%
  \item[{\makebox[\mh@numwidth][l]{\sffamily\bfseries\color{mhgreen}#1}}]\ignorespaces}
  {\end{list}\mh@keep{.3\textheight}}

% KaTeX 写法兼容
\providecommand\lt{<}\providecommand\gt{>}
\providecommand\degree{^{\circ}}
\providecommand\overparen[1]{\wideparen{#1}}
\providecommand\parallelogram{▱}
\providecommand\square{\mdlgwhtsquare}
\endinput
