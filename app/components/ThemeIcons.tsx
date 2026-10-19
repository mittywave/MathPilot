// 浅色/深色切换按钮的图标，介绍页顶栏（LiquidSculptureHero）和工作台顶栏（AppearancePicker）共用：
// 浅色时显示月亮（点了变深色），深色时显示太阳。
export const SunIcon = ({ className }: { className?: string }) => (
  <svg className={className} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const MoonIcon = ({ className }: { className?: string }) => (
  <svg className={className} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13.6 10.1A5.9 5.9 0 0 1 5.9 2.4a5.9 5.9 0 1 0 7.7 7.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);
