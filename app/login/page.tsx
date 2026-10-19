import IntroPage from "../(home)/Intro";

// Where 进入工作台 and every 去登录 lead when nobody is signed in: the product page with its login window open. A
// signed-in teacher (or the Mac itself, which is always the local administrator) goes straight on to `next`.
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next } = await searchParams;
  return <IntroPage login={typeof next === "string" ? next : "/library"} />;
}
