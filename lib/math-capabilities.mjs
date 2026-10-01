/** One supported LaTeX subset shared by repair, prompts and the compiler. */
export const WORD_MATH_STYLE = Object.freeze({ baseSize: 22, font: 'Cambria Math' });
/** @type {Readonly<Record<string,string>>} */
export const SUPPORTED_MATH_SYMBOLS = Object.freeze({
  times:'×',div:'÷',cdot:'·',pm:'±',mp:'∓',le:'≤',leq:'≤',leqslant:'≤',ge:'≥',geq:'≥',geqslant:'≥',
  ne:'≠',neq:'≠',approx:'≈',angle:'∠',triangle:'△',pi:'π',Delta:'Δ',delta:'δ',alpha:'α',beta:'β',gamma:'γ',theta:'θ',
  infty:'∞',therefore:'∴',because:'∵',circ:'°',sim:'∽',backsim:'∽',cong:'≌',perp:'⊥',bot:'⊥',parallel:'∥',
  cdots:'⋯',ldots:'…',vdots:'⋮',dots:'⋯',quad:'　',qquad:'　　',odot:'⊙',bigodot:'⨀',equiv:'≡',cup:'∪',
  Leftrightarrow:'⇔',Rightarrow:'⇒',rightarrow:'→',uparrow:'↑',downarrow:'↓',Uparrow:'⇑',Downarrow:'⇓',
  square:'□',parallelogram:'▱',phi:'ϕ',varphi:'φ',in:'∈',notin:'∉',cap:'∩',to:'→',
  leftarrow:'\u2190',leftrightarrow:'\u2194',Leftarrow:'\u21d0',
  updownarrow:'\u2195',Updownarrow:'\u21d5',nearrow:'\u2197',nwarrow:'\u2196',
  searrow:'\u2198',swarrow:'\u2199',Longleftarrow:'\u27f8',Longrightarrow:'\u27f9',Longleftrightarrow:'\u27fa',
  longleftarrow:'\u27f5',longrightarrow:'\u27f6',longleftrightarrow:'\u27f7',ddots:'\u22f1',checkmark:'✓',
});
export const MATH_FUNCTIONS = Object.freeze(['sin','cos','tan','cot','sec','csc','log','ln','exp','min','max']);
export const MATH_STRUCTURE_COMMANDS = Object.freeze([
  'left','right','text','textrm','mathrm','operatorname','mathit','mathbf','mathbb','boldsymbol',
  'lim','phantom','hphantom','vphantom','frac','dfrac','tfrac','sqrt','widehat','hat',
  'overparen','wideparen','overgroup','underline','overline','sout','xlongequal','mkern','begin','end','hline',
]);
export const SUPPORTED_MATH_COMMANDS = new Set([...Object.keys(SUPPORTED_MATH_SYMBOLS), ...MATH_FUNCTIONS, ...MATH_STRUCTURE_COMMANDS]);
export const SUPPORTED_MATH_ENVIRONMENTS = new Set(['cases','aligned','matrix','pmatrix','bmatrix','vmatrix','Vmatrix','array']);
/** @type {Readonly<Record<string,readonly [string,string]>>} */
export const MATH_GRID_DELIMITERS = Object.freeze({ pmatrix:['(',')'], bmatrix:['[',']'], vmatrix:['|','|'], Vmatrix:['\u2016','\u2016'] });
export const mathCapabilityPrompt = `Native Word output supports these environments: ${[...SUPPORTED_MATH_ENVIRONMENTS].join(', ')}. For array use l/c/r columns, @{\\quad}, @{\\qquad}, @{} or thin-space commands, and \\hline at row boundaries in standalone display arrays. Ruled arrays export as editable native Word tables; do not embed ruled arrays inside other equations or table cells. Nest supported grids when the source requires it. Do not invent macros or change mathematics to work around a limitation; report unsupported source notation in warnings.`;
