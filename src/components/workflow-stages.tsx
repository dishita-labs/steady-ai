import { WORKFLOW_STAGES, type WorkflowStage } from "@/lib/agent/workflow";

const LABELS: Record<WorkflowStage, { title: string; detail: string }> = {
  CASE_CREATED: { title: "Case created", detail: "Room photo uploaded with consent" },
  PHOTO_ANALYZED: { title: "Photo analyzed", detail: "Visible hazards, with evidence and uncertainty" },
  REQUIREMENTS_DEFINED: { title: "Requirements", detail: "What a fix must satisfy; missing context asked" },
  PRODUCTS_RESEARCHED: { title: "Research", detail: "Products and page evidence with sources" },
  PRODUCTS_EVALUATED: { title: "Evaluation", detail: "Rules decide: eligible, rejected or verify" },
  PURCHASE_PREPARED: { title: "Cart prepared", detail: "Selected items with reasoning" },
  APPROVAL_PENDING: { title: "Your approval", detail: "Nothing is bought without it" },
  ACTION_COMPLETED: { title: "Done", detail: "Full audit trail available" },
};

export function WorkflowStages({ current }: { current?: WorkflowStage }) {
  const currentIndex = current ? WORKFLOW_STAGES.indexOf(current) : -1;
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {WORKFLOW_STAGES.map((stage, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li
            key={stage}
            className={`rounded-xl border p-4 ${
              active
                ? "border-teal-600 bg-teal-50 dark:bg-teal-950/40"
                : "border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  done || active ? "bg-teal-700 text-white" : "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300"
                }`}
              >
                {i + 1}
              </span>
              <code className="truncate">{stage}</code>
            </div>
            <p className="mt-2 font-semibold text-stone-900 dark:text-stone-100">{LABELS[stage].title}</p>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{LABELS[stage].detail}</p>
          </li>
        );
      })}
    </ol>
  );
}
