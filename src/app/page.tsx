import { IntegrationStatus } from "@/components/integration-status";
import { WorkflowStages } from "@/components/workflow-stages";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12 sm:px-8 sm:py-20">
      <header className="flex flex-col gap-4">
        <p className="text-sm font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">Steady</p>
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl dark:text-stone-50">
          Safer homes for aging parents, one photo at a time.
        </h1>
        <p className="max-w-2xl text-lg text-stone-600 dark:text-stone-400">
          Upload a photo of a room. Steady points out possible fall hazards it can actually see, asks for what it can&apos;t,
          researches products against clear requirements and prepares a cart for your approval, with every step on record.
        </p>
      </header>

      <section aria-labelledby="workflow" className="flex flex-col gap-4">
        <h2 id="workflow" className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          How a case moves
        </h2>
        <WorkflowStages />
      </section>

      <section aria-labelledby="integrations" className="flex flex-col gap-4">
        <h2 id="integrations" className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Integrations
        </h2>
        <IntegrationStatus />
      </section>

      <footer className="border-t border-stone-200 pt-6 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
        Steady is a shopping assistant, not a certified home-safety inspector. A photo can&apos;t show how something is
        anchored or whether it will hold weight. Safety-critical installs may need a professional. Nothing is purchased
        without your explicit approval.
      </footer>
    </main>
  );
}
