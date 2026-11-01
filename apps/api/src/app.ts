import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { actionRegistry, registerAction, type ActionContext } from "@weft/actions";

export function createApp(context: ActionContext = { userId: "development-user" }) {
  return registerAction(new Elysia().use(cors()), actionRegistry.hello, context);
}
