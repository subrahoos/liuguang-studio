import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { featureEntriesForUser } from "@/lib/workspace-feature-entries";

export const runtime = "nodejs";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return noStore(NextResponse.json({ authenticated: false }, { status: 401 }));
  return noStore(NextResponse.json({
    authenticated: true,
    user: {
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      role: user.role,
      featureEntries: await featureEntriesForUser(user),
    },
  }));
}
