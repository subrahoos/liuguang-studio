import { redirect } from "next/navigation";

export default function BoardWorkflowsPage() {
  redirect("/workspace?module=board");
}
