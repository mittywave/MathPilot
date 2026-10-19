import { redirect } from "next/navigation";
import IntroPage from "./Intro";

// The site opens on the product introduction; the 题库 lives at /library. Links from before that move (/?view=…,
// /?studentId=…) still open the view they meant.
const LIBRARY_PARAMS = ["view", "studentId", "class", "tab"];

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (LIBRARY_PARAMS.some((key) => params[key] !== undefined)) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) for (const item of [value ?? []].flat()) query.append(key, item);
    redirect(`/library?${query}`);
  }
  return <IntroPage />;
}
