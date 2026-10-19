import { redirect } from "next/navigation";

// The product introduction is the home page now.
export default function IntroRedirect() {
  redirect("/");
}
