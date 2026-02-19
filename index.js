import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
const BUSINESS_ID = process.env.BUSINESS_ID || 'fd7b4498-6de2-46a9-b9f8-7f136ad06ab6';

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const TEMPERATURE = 0.6;
const PORT = process.env.PORT || 5050;

const TOOLS = [
    {
        type: 'function',
        name: 'lookup_patient',
        description: 'Look up a patient by their phone number to identify the caller.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'The phone number to look up' }
            },
            required: ['phone']
        }
    },
    {
        type: 'function',
        name: 'check_availability',
        description: 'Check available appointment slots. Always call this before booking — never assume slots are unavailable.',
        parameters: {
            type: 'object',
            properties: {
                start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
                end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
                time_preference: {
                    type: 'string',
                    enum: ['morning', 'afternoon', 'any'],
                    description: 'Preferred time of day'
                },
                dentist_id: {
                    type: 'string',
                    description: 'Specific dentist ID if patient has a preference'
                }
            },
            required: ['start_date', 'end_date']
        }
    },
    {
        type: 'function',
        name: 'book_appointment',
        description: 'Book an appointment. Use dentist_id and service_id from check_availability results.',
        parameters: {
            type: 'object',
            properties: {
                patient_name: { type: 'string', description: "Patient's full name" },
                patient_phone: { type: 'string', description: "Patient's phone number" },
                dentist_id: { type: 'string', description: 'Dentist ID from check_availability results' },
                service_id: { type: 'string', description: 'Service ID from check_availability results' },
                appointment_date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format' },
                appointment_time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format' },
                reason: { type: 'string', description: 'Reason for the appointment' }
            },
            required: ['patient_name', 'patient_phone', 'dentist_id', 'appointment_date', 'appointment_time', 'reason']
        }
    },
    {
        type: 'function',
        name: 'cancel_appointment',
        description: 'Cancel an existing appointment.',
        parameters: {
            type: 'object',
            properties: {
                appointment_id: { type: 'string', description: 'ID of the appointment to cancel' }
            },
            required: ['appointment_id']
        }
    },
    {
        type: 'function',
        name: 'get_patient_appointments',
        description: 'Get upcoming appointments for a patient.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: "Patient's phone number" }
            },
            required: ['phone']
        }
    }
];

const buildSystemMessage = () => `You are Eric, a professional and friendly AI dental receptionist for Caberu dental clinic. You are speaking to patients over the phone — keep every response to 1-2 short sentences maximum.

## Start of Call
Greet the caller warmly. Immediately call lookup_patient with their phone number to identify them. If found, greet them by name. If not found, ask for their name and offer to help.

## Booking Flow — follow this order every time
1. Ask what the reason for the visit is.
2. If multiple dentists are available in the results, ask which they prefer. If only one, skip this.
3. Ask what date or time of day they prefer (morning or afternoon).
4. Call check_availability with the dentist_id and time preference. Then offer at most 3 slots simply — e.g. "I have Tuesday the 24th at 9am or 10am, or Wednesday at 2pm. Which works?"
5. Patient picks a slot → call book_appointment immediately with dentist_id from the availability results. Do NOT ask them to confirm again.

## Other Requests
- **Cancel**: Call get_patient_appointments to list bookings, confirm which one, then call cancel_appointment.
- **Appointment info**: Call get_patient_appointments and read out upcoming appointments.
- **Clinic info**: Answer questions about hours, location, and services.

## Rules
- NEVER say there are no slots without first calling check_availability.
- Never offer more than 3 slots at once.
- Never ask for confirmation after the patient picks a slot — just book it.
- Never invent slots — only use results from check_availability.
- For emergencies, advise calling emergency services.
- Current date: ${new Date().toISOString().split('T')[0]}`;


async function executeToolCall(name, args, callerPhone) {
    console.log(`Executing tool: ${name}`, args);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.error('Supabase not configured');
        return { error: 'Backend not configured. Please contact support.' };
    }

    const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/voice-call-ai`;
    let body = {};

    switch (name) {
        case 'lookup_patient':
            body = {
                action: 'lookup_patient',
                phone: args.phone || callerPhone,
                business_id: BUSINESS_ID
            };
            break;

        case 'check_availability':
            const startDate = args.start_date || new Date().toISOString().split('T')[0];
            const endDate = args.end_date || (() => {
                const d = new Date(startDate);
                d.setDate(d.getDate() + 7);
                return d.toISOString().split('T')[0];
            })();
            body = {
                action: 'check_availability',
                start_date: startDate,
                end_date: endDate,
                time_preference: args.time_preference || 'any',
                dentist_id: args.dentist_id || null,
                business_id: BUSINESS_ID
            };
            break;

        case 'book_appointment':
            body = {
                action: 'book_appointment',
                patient_name: args.patient_name,
                patient_phone: args.patient_phone || callerPhone,
                appointment_date: args.appointment_date,
                appointment_time: args.appointment_time,
                dentist_id: args.dentist_id || null,
                service_id: args.service_id || null,
                reason: args.reason,
                business_id: BUSINESS_ID
            };
            break;

        case 'cancel_appointment':
            body = {
                action: 'cancel_appointment',
                appointment_id: args.appointment_id,
                business_id: BUSINESS_ID
            };
            break;

        case 'get_patient_appointments':
            body = {
                action: 'lookup_patient',
                phone: args.phone || callerPhone,
                business_id: BUSINESS_ID
            };
            break;

        default:
            return { error: 'Unknown tool' };
    }

    try {
        console.log('Calling Supabase Edge Function:', edgeFunctionUrl, 'action:', body.action);
        const response = await fetch(edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Edge function error ${response.status}:`, errorText);
            return { error: `Server error ${response.status}. Please try again.` };
        }

        const result = await response.json();
        console.log('Tool result:', result);
        return result;

    } catch (error) {
        console.error('Tool execution error:', error);
        return { error: 'Failed to execute action. Please try again.' };
    }
}

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'response.done',
    'response.function_call_arguments.done',
    'session.created',
    'session.updated'
];

fastify.get('/', async (request, reply) => {
    reply.send({
        message: 'Dental Voice Assistant Server is running!',
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        business_id: BUSINESS_ID ? 'configured' : 'not configured'
    });
});

fastify.all('/incoming-call', async (request, reply) => {
    const callerPhone = request.body?.From || request.query?.From || '';
    console.log('Incoming call from:', callerPhone);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream">
                                      <Parameter name="callerPhone" value="${callerPhone}" />
                                  </Stream>
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        let streamSid = null;
        let callerPhone = '';
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-10-06', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: buildSystemMessage(),
                    voice: VOICE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: { model: 'whisper-1' },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    },
                    tools: TOOLS,
                    tool_choice: 'auto',
                    temperature: TEMPERATURE
                }
            };
            console.log('Sending session update');
            openAiWs.send(JSON.stringify(sessionUpdate));
            setTimeout(sendInitialGreeting, 400);
        };

        const sendInitialGreeting = () => {
            try {
                if (openAiWs.readyState !== WebSocket.OPEN) {
                    console.error('OpenAI WS not open when greeting attempted, state:', openAiWs.readyState);
                    return;
                }
                const callerInfo = callerPhone
                    ? `The caller's phone number is ${callerPhone}. Call lookup_patient immediately with this number. If found, greet them by name. Then follow the booking flow if they want an appointment.`
                    : `Greet the caller warmly, introduce yourself as Eric the dental receptionist at Caberu, and ask how you can help.`;

                const greetingItem = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{
                            type: 'input_text',
                            text: `[System: ${callerInfo}]`
                        }]
                    }
                };
                openAiWs.send(JSON.stringify(greetingItem));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                console.log('Initial greeting sent');
            } catch (e) {
                console.error('sendInitialGreeting failed:', e);
            }
        };

        const handleFunctionCall = async (functionName, callId, args) => {
            console.log(`Function call: ${functionName}`, args);
            const result = await executeToolCall(functionName, args, callerPhone);

            const functionResult = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify(result)
                }
            };

            openAiWs.send(JSON.stringify(functionResult));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Event: ${response.type}`);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }
                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    sendMark(connection, streamSid);
                }

                if (response.type === 'response.function_call_arguments.done') {
                    const args = JSON.parse(response.arguments);
                    await handleFunctionCall(response.name, response.call_id, args);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                if (response.type === 'error') {
                    console.error('OpenAI error:', response.error);
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }
                        break;

                    case 'start':
                        streamSid = data.start.streamSid;
                        if (data.start.customParameters?.callerPhone) {
                            callerPhone = data.start.customParameters.callerPhone;
                        }
                        console.log('Stream started:', streamSid, 'Caller:', callerPhone);
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        break;

                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;

                    default:
                        console.log('Non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing Twilio message:', error);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => console.log('Disconnected from OpenAI Realtime API'));
        openAiWs.on('error', (error) => console.error('OpenAI WebSocket error:', error));
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Dental Voice Assistant listening on port ${PORT}`);
    console.log(`Supabase: ${SUPABASE_URL ? 'configured' : 'NOT configured'}`);
    console.log(`Business ID: ${BUSINESS_ID}`);
});
