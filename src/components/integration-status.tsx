import { INTEGRATIONS } from "@/lib/integrations";

/** Shows each integration boundary. "Verified" only after a real API call has succeeded. */
export function IntegrationStatus() {
  return (
    <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
      {Object.values(INTEGRATIONS).map((i) => (
        <li key={i.name} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-stone-900 dark:text-stone-100">{i.label}</p>
            <p className="text-sm text-stone-600 dark:text-stone-400">{i.role}</p>
          </div>
          <span
            className={`w-fit shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
              i.verified
                ? "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-100"
                : "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100"
            }`}
          >
            {i.verified ? "Verified" : "Not connected yet"}
          </span>
        </li>
      ))}
    </ul>
  );
}
