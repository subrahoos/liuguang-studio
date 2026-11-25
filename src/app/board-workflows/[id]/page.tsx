import { redirect } from "next/navigation";

export default async function BoardWorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/workspace?module=board&boardId=${encodeURIComponent(id)}`);
}
