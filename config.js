module.exports = {
  platform: "github",
  autodiscover: true,
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
      description:
        "Force internal packages to resolve only from our private repository",
      matchPackagePatterns: ["org.rybar.*"],
      registryUrls: [
        "https://repo.jopga.me/releases",
        "https://repo.jopga.me/private",
      ],
      addLabels: ["idp"],
      reviewers: ["team:rybar-mc/maintainers"],
      automerge: true,
      platformAutomerge: true,
    },
  ],
  labels: ["dependencies"],
  commitMessagePrefix: "build(deps): ",
  allowedUnsafeExecutions: ["gradlew"],
  onboarding: false,
  requireConfig: "optional",
};
