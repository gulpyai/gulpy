/** Three demo connectors with fake data: notes, tasks and code. */
import type { Account } from "../mail-provider/data.ts";
import type { MockTool } from "./server.tsx";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface Note {
  id: string;
  title: string;
  body: string;
  owner: string;
}

interface Task {
  id: string;
  title: string;
  due: string | null;
  done: boolean;
  owner: string;
}

interface Issue {
  number: number;
  repository: string;
  title: string;
  state: "open" | "closed";
  owner: string;
}

export function notesTools(): MockTool[] {
  const notes: Note[] = [
    { id: "note-1", title: "Q4 plan", body: "Launch the agent SDK. Hire two engineers. Keep the budget flat.", owner: "acme-1001" },
    { id: "note-2", title: "Interview: Dana", body: "Strong on systems. Wants a Friday start.", owner: "acme-1001" },
    { id: "note-3", title: "Pasta recipe", body: "Tomatoes, garlic, basil. 20 minutes.", owner: "acme-1001" },
    { id: "note-4", title: "Review checklist", body: "Tests pass. Token refresh works.", owner: "acme-1002" },
  ];
  const mine = (account: Account) => notes.filter((note) => note.owner === account.id);
  return [
    {
      name: "search_notes",
      title: "Search notes",
      description: "Finds notes by words in the title or the text.",
      readOnly: true,
      properties: { query: { type: "string", description: "Words to find. Omit to list all notes." } },
      run: (args, account) => {
        const words = text(args.query).toLowerCase().split(/\s+/).filter(Boolean);
        return mine(account)
          .filter((note) => words.every((word) => `${note.title} ${note.body}`.toLowerCase().includes(word)))
          .map(({ id, title }) => ({ id, title }));
      },
    },
    {
      name: "get_note",
      title: "Read a note",
      description: "Gets the full text of one note.",
      readOnly: true,
      properties: { id: { type: "string" } },
      required: ["id"],
      run: (args, account) => mine(account).find((note) => note.id === args.id) ?? { error: "not_found" },
    },
    {
      name: "create_note",
      title: "Create a note",
      description: "Creates a note.",
      readOnly: false,
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
      run: (args, account) => {
        const note = { id: `note-${notes.length + 1}`, title: text(args.title), body: text(args.body), owner: account.id };
        notes.push(note);
        return note;
      },
    },
  ];
}

export function tasksTools(): MockTool[] {
  const tasks: Task[] = [
    { id: "task-1", title: "Send the Q4 agenda", due: "Thursday", done: false, owner: "acme-1001" },
    { id: "task-2", title: "Review pull request 42", due: "Today", done: false, owner: "acme-1001" },
    { id: "task-3", title: "Book the flight to San Francisco", due: null, done: true, owner: "acme-1001" },
    { id: "task-4", title: "Fix the token refresh", due: "Friday", done: false, owner: "acme-1002" },
  ];
  const mine = (account: Account) => tasks.filter((task) => task.owner === account.id);
  return [
    {
      name: "list_tasks",
      title: "List tasks",
      description: "Lists tasks. Open tasks are first.",
      readOnly: true,
      properties: { status: { type: "string", description: '"open", "done" or "all". Default: "open".' } },
      run: (args, account) => {
        const status = text(args.status) || "open";
        return mine(account).filter((task) => status === "all" || (status === "done") === task.done);
      },
    },
    {
      name: "create_task",
      title: "Create a task",
      description: "Creates a task.",
      readOnly: false,
      properties: { title: { type: "string" }, due: { type: "string" } },
      required: ["title"],
      run: (args, account) => {
        const task = { id: `task-${tasks.length + 1}`, title: text(args.title), due: text(args.due) || null, done: false, owner: account.id };
        tasks.push(task);
        return task;
      },
    },
    {
      name: "complete_task",
      title: "Complete a task",
      description: "Marks a task as done.",
      readOnly: false,
      properties: { id: { type: "string" } },
      required: ["id"],
      run: (args, account) => {
        const task = mine(account).find((item) => item.id === args.id);
        if (!task) return { error: "not_found" };
        task.done = true;
        return task;
      },
    },
  ];
}

export function codeTools(): MockTool[] {
  const issues: Issue[] = [
    { number: 41, repository: "gulpy", title: "Add the Microsoft provider", state: "closed", owner: "acme-1001" },
    { number: 42, repository: "gulpy", title: "Refresh fails after 7 days", state: "open", owner: "acme-1001" },
    { number: 7, repository: "website", title: "The pricing page has a wrong link", state: "open", owner: "acme-1001" },
    { number: 3, repository: "notes", title: "Search is slow", state: "open", owner: "acme-1002" },
  ];
  const mine = (account: Account) => issues.filter((issue) => issue.owner === account.id);
  return [
    {
      name: "list_repositories",
      title: "List repositories",
      description: "Lists the repositories of the user.",
      readOnly: true,
      run: (_args, account) => [...new Set(mine(account).map((issue) => issue.repository))],
    },
    {
      name: "list_issues",
      title: "List issues",
      description: "Lists the open issues. Optionally for one repository.",
      readOnly: true,
      properties: { repository: { type: "string" } },
      run: (args, account) =>
        mine(account).filter((issue) => issue.state === "open" && (!args.repository || issue.repository === args.repository)),
    },
    {
      name: "create_issue",
      title: "Create an issue",
      description: "Creates an issue in a repository.",
      readOnly: false,
      properties: { repository: { type: "string" }, title: { type: "string" } },
      required: ["repository", "title"],
      run: (args, account) => {
        const issue: Issue = {
          number: Math.max(...issues.map((item) => item.number)) + 1,
          repository: text(args.repository),
          title: text(args.title),
          state: "open",
          owner: account.id,
        };
        issues.push(issue);
        return issue;
      },
    },
  ];
}

export const DEMO_CONNECTORS = [
  { id: "acme-notes", name: "Acme Notes", description: "Demo notes and documents", color: "1F7A4D", tools: notesTools },
  { id: "acme-tasks", name: "Acme Tasks", description: "Demo tasks and projects", color: "B4530A", tools: tasksTools },
  { id: "acme-code", name: "Acme Code", description: "Demo repositories and issues", color: "24292F", tools: codeTools },
] as const;
