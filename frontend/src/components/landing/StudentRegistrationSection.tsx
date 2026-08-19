import { FormEvent, useState } from "react";
import { CheckCircle2, Send, UserRound } from "lucide-react";
import { useLocation } from "react-router-dom";
import "./studentRegistrationSection.css";

const ENDPOINT = import.meta.env.VITE_STUDENT_FORM_APPS_SCRIPT_URL as string | undefined;

type FormState = {
  name: string;
  rollNumber: string;
  mobile: string;
  email: string;
  college: string;
  course: string;
};

const initialState: FormState = {
  name: "",
  rollNumber: "",
  mobile: "",
  email: "",
  college: "",
  course: ""
};

export function StudentRegistrationSection() {
  const location = useLocation();
  const [form, setForm] = useState<FormState>(initialState);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  if (location.pathname !== "/") return null;

  function update(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ENDPOINT) {
      setStatus("error");
      setMessage("Registration is temporarily unavailable. The Google Sheet endpoint is not configured yet.");
      return;
    }

    if (!/^\d{10}$/.test(form.mobile)) {
      setStatus("error");
      setMessage("Please enter a valid 10-digit mobile number.");
      return;
    }

    setStatus("submitting");
    setMessage("");
    try {
      const body = new URLSearchParams({
        name: form.name.trim(),
        rollNumber: form.rollNumber.trim(),
        mobile: form.mobile.trim(),
        email: form.email.trim(),
        college: form.college.trim(),
        course: form.course.trim(),
        consent: "Yes"
      });

      await fetch(ENDPOINT, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });

      setForm(initialState);
      setStatus("success");
      setMessage("Details submitted successfully.");
    } catch {
      setStatus("error");
      setMessage("Could not submit the form. Please try again.");
    }
  }

  return (
    <section className="student-registration-section" aria-labelledby="student-registration-title">
      <div className="student-registration-card">
        <div className="student-registration-heading">
          <span className="student-registration-icon" aria-hidden="true"><UserRound size={18} /></span>
          <div>
            <span className="student-registration-eyebrow">QUICK REGISTRATION</span>
            <h2 id="student-registration-title">Student Registration</h2>
            <p>Fill in your details and they will be added to our registration sheet.</p>
          </div>
        </div>

        <form className="student-registration-form" onSubmit={submit}>
          <label>Full Name<input required value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Your name" /></label>
          <label>Roll Number<input required value={form.rollNumber} onChange={(e) => update("rollNumber", e.target.value)} placeholder="Roll number" /></label>
          <label>Mobile Number<input required inputMode="numeric" maxLength={10} value={form.mobile} onChange={(e) => update("mobile", e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="10-digit number" /></label>
          <label>Email<input required type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.com" /></label>
          <label>College / Institution<input value={form.college} onChange={(e) => update("college", e.target.value)} placeholder="College name" /></label>
          <label>Course / Branch<input value={form.course} onChange={(e) => update("course", e.target.value)} placeholder="e.g. B.Tech CSE" /></label>
          <button className="student-registration-submit" disabled={status === "submitting"} type="submit">
            {status === "submitting" ? "Submitting…" : <><Send size={16} /> Submit Details</>}
          </button>
        </form>

        {status !== "idle" && (
          <div className={`student-registration-status ${status}`} role="status">
            {status === "success" && <CheckCircle2 size={16} />}
            <span>{message}</span>
          </div>
        )}
      </div>
    </section>
  );
}
