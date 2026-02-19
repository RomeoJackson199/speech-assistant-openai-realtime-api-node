import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string[] {
  const digits = raw.replace(/\D/g, "");
  const variants = new Set<string>();
  variants.add(digits);
  variants.add(`+${digits}`);
  if (digits.startsWith("32")) {
    variants.add(`0${digits.slice(2)}`);
  } else if (digits.startsWith("0")) {
    variants.add(`+32${digits.slice(1)}`);
    variants.add(`32${digits.slice(1)}`);
  } else {
    variants.add(`+32${digits}`);
    variants.add(`32${digits}`);
  }
  return [...variants];
}

async function encryptForBusiness(supabase: any, businessId: string, value: string | null): Promise<string | null> {
  if (!value) return null;
  try {
    const { data, error } = await supabase.rpc("encrypt_for_business", {
      p_business_id: businessId,
      p_value: value,
    });
    if (error) return value;
    return data as string;
  } catch {
    return value;
  }
}

// Generate available 30-min slots from existing appointments — no pre-generated slots needed
function generateSlots(
  existingApts: { appointment_date: string; duration_minutes: number; dentist_id: string }[],
  dentists: { id: string; name: string }[],
  startDate: Date,
  endDate: Date,
  timePreference: string,
  requestedDentistId?: string
): { date: string; time: string; dentist_id: string; dentist_name: string }[] {
  const workStart = timePreference === "afternoon" ? 12 : 9;
  const workEnd = timePreference === "morning" ? 12 : 17;

  const dentistsToCheck = requestedDentistId
    ? dentists.filter((d) => d.id === requestedDentistId)
    : dentists;

  // Build blocked intervals per dentist
  const blocked: Record<string, { start: number; end: number }[]> = {};
  for (const apt of existingApts) {
    const d = apt.dentist_id;
    if (!blocked[d]) blocked[d] = [];
    const start = new Date(apt.appointment_date).getTime();
    const end = start + (apt.duration_minutes || 30) * 60000;
    blocked[d].push({ start, end });
  }

  const slots: { date: string; time: string; dentist_id: string; dentist_name: string }[] = [];
  const now = Date.now();

  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (current <= end && slots.length < 30) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) { // skip weekends
      for (const dentist of dentistsToCheck) {
        const blockedForDentist = blocked[dentist.id] || [];
        for (let hour = workStart; hour < workEnd; hour++) {
          for (const minute of [0, 30]) {
            const slotStart = new Date(current);
            slotStart.setHours(hour, minute, 0, 0);
            const slotEnd = new Date(slotStart.getTime() + 30 * 60000);

            if (slotStart.getTime() <= now) continue; // must be future

            const overlaps = blockedForDentist.some(
              (b) => slotStart.getTime() < b.end && slotEnd.getTime() > b.start
            );

            if (!overlaps) {
              slots.push({
                date: slotStart.toISOString().slice(0, 10),
                time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
                dentist_id: dentist.id,
                dentist_name: dentist.name,
              });
            }
          }
        }
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return slots;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { action, business_id } = body;

    if (!business_id) return json({ error: "business_id required" }, 400);

    // ─── GET BUSINESS CONTEXT ──────────────────────────────────────
    if (action === "get_business_context") {
      const { data: business, error: bizErr } = await supabase
        .from("businesses")
        .select("name, specialty_type, ai_instructions, ai_greeting, ai_tone, welcome_message, phone, address, default_language")
        .eq("id", business_id)
        .single();

      if (bizErr || !business) return json({ error: "Business not found" }, 404);

      const { data: services } = await supabase
        .from("business_services")
        .select("id, name, description, duration_minutes, category")
        .eq("business_id", business_id)
        .eq("is_active", true)
        .order("name", { ascending: true });

      const { data: members } = await supabase
        .from("business_members")
        .select("profile_id")
        .eq("business_id", business_id)
        .eq("role", "dentist");

      const memberProfileIds = (members || []).map((m: any) => m.profile_id);

      let filteredDentists: any[] = [];
      if (memberProfileIds.length > 0) {
        const { data: allDentists } = await supabase
          .from("dentists")
          .select("id, first_name, last_name, specialization")
          .in("profile_id", memberProfileIds)
          .eq("is_active", true);

        filteredDentists = (allDentists || []).map((d: any) => ({
          id: d.id,
          name: `${d.first_name || ""} ${d.last_name || ""}`.trim() || "Unknown",
          specialization: d.specialization || null,
        }));
      }

      return json({
        business: {
          name: business.name,
          specialty_type: business.specialty_type,
          ai_instructions: business.ai_instructions,
          ai_greeting: business.ai_greeting,
          ai_tone: business.ai_tone,
          welcome_message: business.welcome_message,
          phone: business.phone,
          address: business.address,
          language: business.default_language || "en",
        },
        services: (services || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          duration_minutes: s.duration_minutes,
          category: s.category,
        })),
        dentists: filteredDentists,
      });
    }

    // ─── LOOKUP PATIENT ────────────────────────────────────────────
    if (action === "lookup_patient") {
      const phone = body.phone || "";
      if (!phone) return json({ error: "phone required" }, 400);
      const variants = normalizePhone(phone);
      const orFilter = variants.map((p) => `phone.eq.${p}`).join(",");

      const { data: scopedPatients } = await supabase
        .from("profiles")
        .select("id, first_name, last_name, phone, email")
        .or(orFilter)
        .eq("business_id", business_id)
        .limit(1);

      let patient = scopedPatients?.[0] || null;

      if (!patient) {
        const { data: globalPatients } = await supabase
          .from("profiles")
          .select("id, first_name, last_name, phone, email")
          .or(orFilter)
          .limit(1);
        patient = globalPatients?.[0] || null;
      }

      if (!patient) return json({ found: false, message: "No patient found with this phone number" });

      return json({
        found: true,
        patient_id: patient.id,
        name: `${patient.first_name || ""} ${patient.last_name || ""}`.trim(),
        phone: patient.phone,
        email: patient.email,
      });
    }

    // ─── CHECK AVAILABILITY ────────────────────────────────────────
    // No pre-generated slots — computes free time from existing appointments
    if (action === "check_availability") {
      const { start_date, end_date, time_preference = "any", dentist_id } = body;
      if (!start_date || !end_date) return json({ error: "start_date and end_date required" }, 400);

      // Get dentists for this business
      const { data: members } = await supabase
        .from("business_members")
        .select("profile_id")
        .eq("business_id", business_id)
        .eq("role", "dentist");

      const memberProfileIds = (members || []).map((m: any) => m.profile_id);
      if (memberProfileIds.length === 0) {
        return json({ available: false, message: "No dentists found for this business.", slots: [] });
      }

      let dentistQuery = supabase
        .from("dentists")
        .select("id, first_name, last_name")
        .in("profile_id", memberProfileIds)
        .eq("is_active", true);

      if (dentist_id) dentistQuery = dentistQuery.eq("id", dentist_id);

      const { data: dentistsData } = await dentistQuery;
      if (!dentistsData || dentistsData.length === 0) {
        return json({ available: false, message: "No active dentists found.", slots: [] });
      }

      const dentists = dentistsData.map((d: any) => ({
        id: d.id,
        name: `Dr. ${d.last_name || d.first_name}`,
      }));

      const dentistIds = dentists.map((d: any) => d.id);

      // Fetch existing appointments in range
      const { data: existingApts } = await supabase
        .from("appointments")
        .select("appointment_date, duration_minutes, dentist_id")
        .in("dentist_id", dentistIds)
        .eq("business_id", business_id)
        .not("status", "eq", "cancelled")
        .gte("appointment_date", `${start_date}T00:00:00`)
        .lte("appointment_date", `${end_date}T23:59:59`);

      const slots = generateSlots(
        existingApts || [],
        dentists,
        new Date(start_date),
        new Date(end_date),
        time_preference,
        dentist_id
      );

      if (slots.length === 0) {
        return json({
          available: false,
          message: "No available slots in this range. Try different dates.",
          slots: [],
        });
      }

      return json({
        available: true,
        slots: slots.slice(0, 6),
      });
    }

    // ─── BOOK APPOINTMENT ──────────────────────────────────────────
    if (action === "book_appointment") {
      const { patient_name, patient_phone, appointment_date, appointment_time, dentist_id, service_id, reason } = body;

      if (!appointment_date || !appointment_time || !dentist_id) {
        return json({ error: "appointment_date, appointment_time, and dentist_id are required" }, 400);
      }

      // 1. Find or create patient
      const phone = patient_phone || "";
      let patientId: string | null = null;

      if (phone) {
        const variants = normalizePhone(phone);
        const { data: existing } = await supabase
          .from("profiles")
          .select("id")
          .or(variants.map((p) => `phone.eq.${p}`).join(","))
          .limit(1)
          .maybeSingle();
        patientId = existing?.id || null;
      }

      if (!patientId) {
        const nameParts = (patient_name || "New Patient").trim().split(" ");
        const { data: newProfile, error: createErr } = await supabase
          .from("profiles")
          .insert({
            first_name: nameParts[0] || "Unknown",
            last_name: nameParts.slice(1).join(" ") || "",
            phone: phone || null,
            role: "patient",
            profile_completion_status: "incomplete",
          })
          .select("id")
          .single();

        if (createErr) return json({ error: "Failed to create patient profile" }, 500);
        patientId = newProfile.id;
      }

      // 2. Get service duration
      let durationMinutes = 30;
      if (service_id) {
        const { data: svc } = await supabase
          .from("business_services")
          .select("duration_minutes")
          .eq("id", service_id)
          .maybeSingle();
        if (svc?.duration_minutes) durationMinutes = svc.duration_minutes;
      }

      // 3. Conflict check — ensure slot is still free
      const timeStr = appointment_time.length === 5 ? `${appointment_time}:00` : appointment_time;
      const aptStart = new Date(`${appointment_date}T${timeStr}`);
      const aptEnd = new Date(aptStart.getTime() + durationMinutes * 60000);

      const { data: conflicts } = await supabase
        .from("appointments")
        .select("id")
        .eq("dentist_id", dentist_id)
        .eq("business_id", business_id)
        .not("status", "eq", "cancelled")
        .lt("appointment_date", aptEnd.toISOString())
        .gte("appointment_date", aptStart.toISOString())
        .limit(1);

      if (conflicts && conflicts.length > 0) {
        return json({ error: "That slot was just taken. Please choose another time." }, 409);
      }

      // 4. Encrypt PHI
      const [encryptedReason, encryptedPatientName] = await Promise.all([
        encryptForBusiness(supabase, business_id, reason || null),
        encryptForBusiness(supabase, business_id, patient_name || null),
      ]);

      // 5. Insert
      const { data: appointment, error: aptErr } = await supabase
        .from("appointments")
        .insert({
          business_id,
          patient_id: patientId,
          dentist_id,
          appointment_date: `${appointment_date}T${timeStr}`,
          duration_minutes: durationMinutes,
          service_id: service_id || null,
          reason: encryptedReason,
          patient_name: encryptedPatientName,
          status: "confirmed",
          booking_source: "voice",
        })
        .select("id, appointment_date, status")
        .single();

      if (aptErr) {
        console.error("book_appointment error:", aptErr);
        return json({ error: `Failed to book: ${aptErr.message}` }, 500);
      }

      return json({
        success: true,
        appointment_id: appointment.id,
        date: appointment_date,
        time: appointment_time,
        message: `Appointment confirmed for ${patient_name || "patient"} on ${appointment_date} at ${appointment_time}.`,
      });
    }

    // ─── CANCEL APPOINTMENT ────────────────────────────────────────
    if (action === "cancel_appointment") {
      const { appointment_id } = body;
      if (!appointment_id) return json({ error: "appointment_id required" }, 400);

      const { data: apt, error: cancelErr } = await supabase
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", appointment_id)
        .eq("business_id", business_id)
        .select("id")
        .single();

      if (cancelErr) return json({ error: "Failed to cancel appointment" }, 500);
      return json({ success: true, message: "Appointment cancelled.", appointment_id: apt.id });
    }

    // ─── GET PATIENT APPOINTMENTS ──────────────────────────────────
    if (action === "get_patient_appointments") {
      const phone = body.phone || "";
      if (!phone) return json({ error: "phone required" }, 400);
      const variants = normalizePhone(phone);

      const { data: patientRow } = await supabase
        .from("profiles")
        .select("id")
        .or(variants.map((p) => `phone.eq.${p}`).join(","))
        .limit(1)
        .maybeSingle();

      if (!patientRow) return json({ found: false, message: "No patient found.", appointments: [] });

      const { data: appointments, error } = await supabase
        .from("appointments")
        .select(`id, appointment_date, duration_minutes, status, dentists!inner ( first_name, last_name ), business_services ( name )`)
        .eq("patient_id", patientRow.id)
        .eq("business_id", business_id)
        .gte("appointment_date", new Date().toISOString())
        .in("status", ["confirmed", "pending"])
        .order("appointment_date", { ascending: true })
        .limit(5);

      if (error) return json({ error: "Failed to fetch appointments" }, 500);

      return json({
        found: true,
        appointments: (appointments || []).map((a: any) => ({
          appointment_id: a.id,
          date: a.appointment_date,
          duration_minutes: a.duration_minutes,
          status: a.status,
          dentist_name: `Dr. ${a.dentists?.last_name || a.dentists?.first_name || "Unknown"}`,
          service: a.business_services?.name || null,
        })),
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error("voice-call-ai unhandled error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
