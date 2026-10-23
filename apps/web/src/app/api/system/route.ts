import { route } from "@/lib/api";
import { systemInfo } from "@/lib/services/system";

export const dynamic = "force-dynamic";

export const GET = route(async () => systemInfo());
