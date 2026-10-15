#!/bin/zsh
set -e
cd "${0:A:h}"

if [[ ! -d node_modules ]]; then
  echo "首次启动，正在准备 MathPilot……"
  npm install
fi

if [[ ! -f .env.local ]] || ! /usr/bin/grep -Eq '^OPENAI_API_KEY=.+' .env.local; then
  setup_result=$(osascript <<'APPLESCRIPT'
set baseResult to display dialog "请输入 API 基础地址。使用自建 Sub2API 时填写你的中转站地址并以 /v1 结尾；使用官方服务可保留默认值。" default answer "https://api.openai.com/v1" with title "MathPilot 智能识别 · 第 1 步" buttons {"暂不设置", "下一步"} default button "下一步"
if button returned of baseResult is "暂不设置" then return "SKIP"
set keyResult to display dialog "请输入这个服务签发的 API Key。Key 只会保存在本机。" default answer "" with title "MathPilot 智能识别 · 第 2 步" buttons {"暂不设置", "下一步"} default button "下一步" with hidden answer
if button returned of keyResult is "暂不设置" then return "SKIP"
set modelResult to display dialog "请输入中转站中支持图片理解的模型名称。推荐先使用你已映射的 Gemini 视觉模型。" default answer "gemini-3.8-flash-high" with title "MathPilot 智能识别 · 第 3 步" buttons {"取消设置", "保存并启用"} default button "保存并启用"
if button returned of modelResult is "取消设置" then return "SKIP"
return (text returned of baseResult) & linefeed & (text returned of keyResult) & linefeed & (text returned of modelResult)
APPLESCRIPT
  )
  if [[ "$setup_result" != "SKIP" ]]; then
    setup_base=$(printf '%s\n' "$setup_result" | sed -n '1p')
    setup_key=$(printf '%s\n' "$setup_result" | sed -n '2p')
    setup_model=$(printf '%s\n' "$setup_result" | sed -n '3p')
  fi
  if [[ -n "$setup_base" && -n "$setup_key" && -n "$setup_model" ]]; then
    printf 'OPENAI_BASE_URL=%s\nOPENAI_API_KEY=%s\nOPENAI_VISION_MODEL=%s\nOPENAI_TEXT_MODEL=%s\nOPENAI_REASONING_EFFORT=high\nOPENAI_API_MODE=responses\n' "$setup_base" "$setup_key" "$setup_model" "$setup_model" > .env.local
    chmod 600 .env.local
  fi
fi

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

echo "MathPilot 已启动，浏览器将自动打开。"
echo "关闭这个窗口即可停止运行。"
(sleep 2; open "http://127.0.0.1:3001") &
npm run dev
