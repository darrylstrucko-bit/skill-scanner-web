import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Skill Scanner Console",
    short_name: "Skill Scanner",
    description:
      "Use the Skill Scanner Console to check your skill file for prompt injection, tool poisoning and data exfiltration. Cisco's Skill Scanner uses a combination of static YARA signatures and LLM-based semantic analysis to detect malicious patterns and behaviors.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#6d28d9",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
