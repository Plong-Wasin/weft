import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Elysia } from "elysia";

export type ActionKind = "read" | "write";

export interface ActionContext {
  userId: string;
}

export interface Action<Input extends TSchema, Output extends TSchema> {
  name: string;
  kind: ActionKind;
  input: Input;
  output: Output;
  permission: (context: ActionContext, input: Static<Input>) => boolean | Promise<boolean>;
  handler: (context: ActionContext, input: Static<Input>) => Static<Output> | Promise<Static<Output>>;
}

export function defineAction<Input extends TSchema, Output extends TSchema>(action: Action<Input, Output>, context: ActionContext = { userId: "development-user" }) {
  return action;
}

export const helloAction = defineAction({
  name: "hello",
  kind: "read",
  input: Type.Object({ name: Type.String({ minLength: 1 }) }),
  output: Type.Object({ greeting: Type.String() }),
  permission: (context: ActionContext) => context.userId.length > 0,
  handler: (_context: ActionContext, input: { name: string }) => ({ greeting: `Hello, ${input.name}!` }),
});

export function registerAction<
  App extends Elysia,
  Input extends TSchema,
  Output extends TSchema,
>(app: App, action: Action<Input, Output>, context: ActionContext = { userId: "development-user" }) {
  return app.post(`/actions/${action.name}`, async ({ body, set }) => {
    if (!(await action.permission(context, body as Static<Input>))) {
      set.status = 403;
      return { error: "Forbidden" };
    }
    return action.handler(context, body as Static<Input>);
  }, {
    body: action.input,
    response: { 200: action.output, 403: Type.Object({ error: Type.String() }) },
  });
}

export const actionRegistry = { hello: helloAction } as const;
