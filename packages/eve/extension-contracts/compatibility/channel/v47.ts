import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 47 invokeTool options had no `key`; epoch 48 adds it.
export default defineChannel({
  routes: [
    POST("/tools/:name", async (request, { describe, invokeTool, params }) => {
      const { tools } = await describe();
      if (!tools.some((tool) => tool.name === params.name)) {
        return Response.json({ error: "unknown tool" }, { status: 404 });
      }
      const auth = {
        attributes: {},
        authenticator: "fixture",
        principalId: "fixture",
        principalType: "service",
      };
      return Response.json(await invokeTool(params.name!, await request.json(), { auth }));
    }),
  ],
});
