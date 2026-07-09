/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      colors: {
        hologram: {
          bg: "#F5F0FF",
          bg2: "#EDE7F6",
          ink: "#1E1B4B",
          muted: "#6B7280",
          primary: "#7C3AED",
          secondary: "#4F46E5",
          accent: "#C084FC",
          violet: "#A855F7"
        }
      },
      boxShadow: {
        soft: "0 12px 40px rgba(15, 23, 42, 0.12)",
        hologram: "10px 10px 26px rgba(124, 58, 237, 0.16), -10px -10px 26px rgba(255, 255, 255, 0.78)",
        "hologram-glow": "0 18px 42px rgba(124, 58, 237, 0.3)"
      },
      keyframes: {
        "hologram-float": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" }
        },
        "hologram-shift": {
          "0%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" }
        }
      },
      animation: {
        "hologram-float": "hologram-float 3s ease-in-out infinite",
        "hologram-shift": "hologram-shift 6s ease infinite"
      }
    }
  },
  plugins: []
};
