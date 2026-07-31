import { redirect } from "next/navigation";

/** The library is the app's home. */
export default function Home() {
  redirect("/books");
}
