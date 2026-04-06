module.exports = {
  platform: "github",
  autodiscover: true,
  autodiscoverFilter: [
    "!rybar-mc/hydro",
    "!rybar-mc/grim",
    "!rybar-mc/luckperms",
    "!rybar-mc/spark",
  ],
  hostRules: [
    {
      matchHost: "repo.jopga.me",
      hostType: "maven",
      username: process.env.RENOVATE_JOPGA_USER,
      password: process.env.RENOVATE_JOPGA_PASSWORD,
    },
  ],
  packageRules: [
    {
      matchPackagePatterns: ["org.rybar.*"],
      registryUrls: [
        "https://repo.jopga.me/releases",
        "https://repo.jopga.me/private",
      ],
      addLabels: ["idp", "automerge"],
    },
    {
      matchPackagePatterns: ["org.jetbrains:annotations", "org.projectlombok"],
      addLabels: ["automerge"],
    },
    {
      description: "do not assign reviewers to automerge or internal packages",
      matchLabels: ["idp", "automerge"],
      reviewers: [],
    },
    {
      description: "assign default reviewers to all other dependencies",
      matchAll: true,
      reviewers: ["xhyrom", "nogodhenry"],
    },
  ],
  prNotPendingHours: 1,
  labels: ["dependencies"],
  commitMessagePrefix: "build(deps): ",
  allowedUnsafeExecutions: ["gradlew", "gradleWrapper"],
  onboarding: false,
  requireConfig: "optional",
};
