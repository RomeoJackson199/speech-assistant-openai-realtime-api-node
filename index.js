import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, BUSINESS_ID } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy'; // Using alloy for clear, professional voice
const TEMPERATURE = 0.6;
const PORT = process.env.PORT || 5050;

// Tool definitions for OpenAI Realtime API function calling
const TOOLS = [
    {
        type: 'function',
        name: 'lookup_patient',
        description: 'Look up a patient by their phone number. Use this when the call starts to identify the caller, or when asked about patient information.',
        parameters: {
            type: 'object',
            properties: {
                phone: {
                    type: 'string',
                    description: 'The phone number to look up (caller ID or provided number)'
                }
            },
            required: ['phone']
        }
    },
    {
        type: 'function',
        name: 'check_availability',
        description: 'Check available appointment slots. Use when patient asks about availability or wants to see open times.',
        parameters: {
            type: 'object',
            properties: {
                start_date: {
                    type: 'string',
                    description: 'Start date in YYYY-MM-DD format'
                },
                end_date: {
                    type: 'string',
                    description: 'End date in YYYY-MM-DD format'
                },
                time_preference: {
                    type: 'string',
                    enum: ['morning', 'afternoon', 'evening', 'any'],
                    description: 'Preferred time of day'
                }
            },
            required: ['start_date', 'end_date']
        }
    },
    {
        type: 'function',
        name: 'book_appointment',
        description: 'Book an appointment for a patient. Confirm all details with the patient before calling this.',
        parameters: {
            type: 'object',
            properties: {
                patient_name: {
                    type: 'string',
                    description: "Patient's full name"
                },
                patient_phone: {
                    type: 'string',
                    description: "Patient's phone number"
                },
                appointment_date: {
                    type: 'string',
                    description: 'Appointment date and time (can be natural language like "tomorrow 3pm" or "Friday morning")'
                },
                reason: {
                    type: 'string',
                    description: 'Reason for the appointment (e.g., cleaning, checkup, toothache)'
                }
            },
            required: ['patient_name', 'patient_phone', 'appointment_date', 'reason']
        }
    },
    {
        type: 'function',
        name: 'cancel_appointment',
        description: 'Cancel an existing appointment. Always confirm with patient before cancelling.',
        parameters: {
            type: 'object',
            properties: {
                appointment_id: {
                    type: 'string',
                    description: 'ID of the appointment to cancel'
                }
            },
            required: ['appointment_id']
        }
    },
    {
        type: 'function',
        name: 'get_patient_appointments',
        description: 'Get upcoming appointments for a patient. Use when patient asks about their scheduled appointments.',
        parameters: {
            type: 'object',
            properties: {
                phone: {
                    type: 'string',
                    description: "Patient's phone number"
                }
            },
            required: ['phone']
        }
    }
];

// System message with workflow instructions
const SYSTEM_MESSAGE = `You are Eric, a professional and friendly AI dental receptionist for Caberu dental clinic. You're speaking to patients over the phone.

## Your Workflow

1. **Start of Call**: Greet the caller warmly. Try to identify them using their phone number (caller ID).

2. **Patient Identified**: If you find their profile, greet them by name and ask how you can help today.

3. **Patient Not Found**: If you can't find them, politely ask for their name and let them know you can still help.

4. **Handle Requests**:
   - **Book Appointment**: Ask for preferred date/time and reason. Check availability, then confirm and book.
   - **Cancel Appointment**: Look up their appointments, confirm which one to cancel, then cancel it.
   - **Appointment Info**: Look up and tell them about their upcoming appointments.
   - **Clinic Info**: Answer questions about hours, location, and services.

## Guidelines

- Be concise - this is a phone conversation
- Confirm important details by repeating them back
- Use natural, conversational language
- When using a tool, briefly tell the patient what you're doing (e.g., "Let me check that for you...")
- For emergencies, advise calling emergency services
- If asked about medical advice, explain the dentist will discuss that during the appointment

## Important

- Always confirm before booking or cancelling
- Current date: ${new Date().toISOString().split('T')[0]}
- Use the available tools to help patients`;

// Execute tool calls by calling Supabase Edge Functions
async function executeToolCall(name, args, callerPhone) {
    console.log(`Executing tool: ${name}`, args);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.error('Supabase not configured');
        return { error: 'Backend not configured. Please contact support.' };
    }

    const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/voice-call-ai`;

    try {
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
                body = {
                    message: `Check availability from ${args.start_date} to ${args.end_date}`,
                    conversation_history: [],
                    caller_phone: callerPhone,
                    business_id: BUSINESS_ID
                };
                break;

            case 'book_appointment':
                body = {
                    name: args.patient_name,
                    phone: args.patient_phone || callerPhone,
                    appointment_date: args.appointment_date,
                    symptoms: args.reason,
                    business_id: BUSINESS_ID
                };
                break;

            case 'cancel_appointment':
                body = {
                    message: `Cancel appointment ${args.appointment_id}`,
                    conversation_history: [],
                    caller_phone: callerPhone,
                    business_id: BUSINESS_ID
                };
                break;

            case 'get_patient_appointments':
                body = {
                    message: 'What are my upcoming appointments?',
                    conversation_history: [],
                    caller_phone: args.phone || callerPhone,
                    business_id: BUSINESS_ID
                };
                break;

            default:
                return { error: 'Unknown tool' };
        }

        console.log('Calling Supabase Edge Function:', edgeFunctionUrl);
        const response = await fetch(edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify(body)
        });

        const result = await response.json();
        console.log('Tool result:', result);
        return result;

    } catch (error) {
        console.error('Tool execution error:', error);
        return { error: 'Failed to execute action. Please try again.' };
    }
}

// Log event types
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'response.done',
    'response.function_call_arguments.done',
    'session.created',
    'session.updated'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({
        message: 'Dental Voice Assistant Server is running!',
        supabase_configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
        business_id: BUSINESS_ID ? 'configured' : 'not configured'
    });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    // Extract caller phone number from Twilio request
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

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let callerPhone = '';
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // Initialize session with tools
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: SYSTEM_MESSAGE,
                    voice: VOICE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        model: 'whisper-1'
                    },
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

            console.log('Sending session update with tools');
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Send initial greeting
            setTimeout(() => {
                sendInitialGreeting();
            }, 250);
        };

        // Send initial greeting, mentioning caller ID lookup
        const sendInitialGreeting = async () => {
            // If we have caller phone, try to look them up first
            let greetingContext = '';
            if (callerPhone && SUPABASE_URL && SUPABASE_ANON_KEY) {
                try {
                    const lookupResult = await executeToolCall('lookup_patient', { phone: callerPhone }, callerPhone);
                    if (lookupResult.found && lookupResult.profile) {
                        greetingContext = `The caller has been identified as ${lookupResult.profile.first_name} ${lookupResult.profile.last_name}. Greet them by name.`;
                    } else {
                        greetingContext = 'The caller is not in our system. Greet them warmly and offer to help.';
                    }
                } catch (e) {
                    console.error('Initial lookup failed:', e);
                    greetingContext = 'Could not look up caller. Greet them warmly.';
                }
            } else {
                greetingContext = 'Greet the caller warmly and offer to help with appointments.';
            }

            const greetingItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{
                        type: 'input_text',
                        text: `[System: ${greetingContext}] Start the conversation with a warm greeting.`
                    }]
                }
            };

            openAiWs.send(JSON.stringify(greetingItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle function calls from OpenAI
        const handleFunctionCall = async (functionName, callId, args) => {
            console.log(`Function call: ${functionName}`, args);

            const result = await executeToolCall(functionName, args, callerPhone);

            // Send function result back to OpenAI
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

        // Handle interruption
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

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark for playback tracking
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

        // OpenAI WebSocket handlers
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

                // Handle audio output
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

                // Handle function calls
                if (response.type === 'response.function_call_arguments.done') {
                    const args = JSON.parse(response.arguments);
                    await handleFunctionCall(response.name, response.call_id, args);
                }

                // Handle speech interruption
                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // Log errors
                if (response.type === 'error') {
                    console.error('OpenAI error:', response.error);
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        // Handle Twilio messages
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;

                    case 'start':
                        streamSid = data.start.streamSid;
                        // Extract caller phone from custom parameters
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

        openAiWs.on('close', () => {
            console.log('Disconnected from OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Dental Voice Assistant listening on port ${PORT}`);
    console.log(`Supabase: ${SUPABASE_URL ? 'configured' : 'NOT configured'}`);
    console.log(`Business ID: ${BUSINESS_ID || 'NOT configured'}`);
});
