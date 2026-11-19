import { handleAccrualRequest } from "@/lib/accrual-handler";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const params = await context.params;
  return handleAccrualRequest(request, { id: params.id });
}
