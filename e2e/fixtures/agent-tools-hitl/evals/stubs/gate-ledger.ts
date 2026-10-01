import { defineToolStubs } from "eve/evals";

/** Stubs the approval-gated `gate` tool and `read-status` over one shared ledger. */
export default defineToolStubs({
  state: () => ({ markers: ["seeded-marker"] }),
  tools: {
    gate: ({ marker }: { marker: string }, { state }) => {
      state.markers.push(marker);
      return { executed: true, marker, stubbed: true };
    },
    "read-status": ({ marker }: { marker: string }, { state }) => ({
      ledger: state.markers.join(","),
      marker,
      status: "stubbed",
    }),
  },
});
