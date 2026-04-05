module.exports = {
  platform: "github",
  autodiscover: true,
  hostRules: [
    {
      matchHost: "https://repo.jopga.me/private",
      username: process.env.JOPGA_USER,
      password: process.env.JOPGA_PASSWORD,
    },
  ],
  packageRules: [
    {
      description:
        "Force internal packages to resolve only from our private repository",
      matchPackagePatterns: ["org.rybar.*"],
      registryUrls: ["https://repo.jopga.me/private"],
      addLabels: ["idp"],
      reviewers: ["team:rybar-mc/maintainers"],
      automerge: true,
      platformAutomerge: true,
    },
  ],
  labels: ["dependencies"],
  commitMessagePrefix: "build(deps): ",
  onboarding: false,
  requireConfig: "optional",
};
