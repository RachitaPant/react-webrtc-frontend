import React, { useEffect, useCallback, useState } from "react";
import ReactPlayer from "react-player";
import peer from "../service/peer";
import { useSocket } from "../context/SocketProvider";

const RoomPage = () => {
  const socket = useSocket();
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [myStream, setMyStream] = useState();
  const [remoteStream, setRemoteStream] = useState();
  const [recognizer, setRecognizer] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [callActive, setCallActive] = useState(false);

  // Load Vosk model
  useEffect(() => {
    (async () => {
      if (!window.Vosk) {
        console.error("Vosk not loaded – check script inclusion.");
        return;
      }

      try {
        console.log("Loading Vosk model...");
        const model = await window.Vosk.createModel("model.tar.gz", {
          sync: false,
          fsSync: false,
          persistent: false,
        });

        const rec = new model.KaldiRecognizer(16000);

        rec.on("partialresult", msg =>
          console.log("Partial:", msg.result.partial)
        );
        rec.on("result", msg =>
          setTranscript(prev => prev + " " + msg.result.text)
        );

        setRecognizer(rec);
      } catch (err) {
        console.error("Vosk failed to load:", err);
      }
    })();
  }, []);

  // Connect recognizer to remoteStream
  useEffect(() => {
    if (!remoteStream || !recognizer) return;
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(remoteStream);
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = e => {
      try {
        recognizer.acceptWaveform(e.inputBuffer);
      } catch (err) {
        console.error("Vosk error:", err);
      }
    };
    src.connect(proc);
    proc.connect(audioCtx.destination);
    return () => {
      proc.disconnect();
      src.disconnect();
      audioCtx.close();
    };
  }, [remoteStream, recognizer]);

  // Groq API handler
  const sendToGroq = async text => {
    try {
      const response = await fetch(
        "https://serverless-groq-endpoint.vercel.app/api/server",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "system",
                content: "You are an assistant summarizing meeting transcripts.",
              },
              { role: "user", content: `Transcript: ${text}` },
            ],
          }),
        }
      );

      if (!response.ok)
        throw new Error(`Groq API error: ${response.statusText}`);

      const data = await response.json();
      console.log("Groq Summary:", data.choices[0].message.content);
      return data.choices[0].message.content;
    } catch (err) {
      console.error("Failed to send transcript to Groq:", err);
      return "Failed to get summary.";
    }
  };

  // End Call Handler
  const handleEndCall = async () => {
    try {
      console.log("Ending call...");

      // Stop local tracks
      if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
        setMyStream(null);
      }

      // Stop remote tracks
      if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        setRemoteStream(null);
      }

      // Stop recognizer
      if (recognizer) {
        recognizer.stop();
      }

      setCallActive(false);
      if (remoteSocketId) {
  socket.emit("call:end", { to: remoteSocketId });
}


      // Send final transcript to Groq
      if (transcript.trim()) {
        const groqSummary = await sendToGroq(transcript);
        setSummary(groqSummary);
      }
    } catch (err) {
      console.error("Error ending call:", err);
    }
  };

  // WebRTC Handlers
  const handleUserJoined = useCallback(({ email, id }) => {
    console.log(`Email ${email} joined room`);
    setRemoteSocketId(id);
  }, []);

  const handleCallUser = useCallback(async () => {
    setCallActive(true);
    setTranscript("");
    setSummary("");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    const offer = await peer.getOffer();
    socket.emit("user:call", { to: remoteSocketId, offer });
    setMyStream(stream);
  }, [remoteSocketId, socket]);

  const handleIncommingCall = useCallback(
    async ({ from, offer }) => {
      setCallActive(true);
      setTranscript("");
      setSummary("");

      setRemoteSocketId(from);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      setMyStream(stream);
      console.log(`Incoming Call`, from, offer);
      const ans = await peer.getAnswer(offer);
      socket.emit("call:accepted", { to: from, ans });
    },
    [socket]
  );

  const sendStreams = useCallback(() => {
    for (const track of myStream.getTracks()) {
      peer.peer.addTrack(track, myStream);
    }
  }, [myStream]);

  const handleCallAccepted = useCallback(
    ({ from, ans }) => {
      peer.setLocalDescription(ans);
      console.log("Call Accepted!");
      sendStreams();
    },
    [sendStreams]
  );

  const handleNegoNeeded = useCallback(async () => {
    const offer = await peer.getOffer();
    socket.emit("peer:nego:needed", { offer, to: remoteSocketId });
  }, [remoteSocketId, socket]);

  useEffect(() => {
    peer.peer.addEventListener("negotiationneeded", handleNegoNeeded);
    return () => {
      peer.peer.removeEventListener("negotiationneeded", handleNegoNeeded);
    };
  }, [handleNegoNeeded]);

  const handleNegoNeedIncomming = useCallback(
    async ({ from, offer }) => {
      const ans = await peer.getAnswer(offer);
      socket.emit("peer:nego:done", { to: from, ans });
    },
    [socket]
  );

  const handleNegoNeedFinal = useCallback(async ({ ans }) => {
    await peer.setLocalDescription(ans);
  }, []);

  useEffect(() => {
    peer.peer.addEventListener("track", async ev => {
      const remoteStream = ev.streams;
      console.log("GOT TRACKS!!");
      setRemoteStream(remoteStream[0]);
    });
  }, []);

  useEffect(() => {
    socket.on("user:joined", handleUserJoined);
    socket.on("incomming:call", handleIncommingCall);
    socket.on("call:accepted", handleCallAccepted);
    socket.on("peer:nego:needed", handleNegoNeedIncomming);
    socket.on("peer:nego:final", handleNegoNeedFinal);
    socket.on("call:end", () => {
  console.log("Call ended by remote user.");
  handleEndCall();
});


    return () => {
      socket.off("user:joined", handleUserJoined);
      socket.off("incomming:call", handleIncommingCall);
      socket.off("call:accepted", handleCallAccepted);
      socket.off("peer:nego:needed", handleNegoNeedIncomming);
      socket.off("peer:nego:final", handleNegoNeedFinal);
        socket.off("call:end");
    };
  }, [
    socket,
    handleUserJoined,
    handleIncommingCall,
    handleCallAccepted,
    handleNegoNeedIncomming,
    handleNegoNeedFinal,
  ]);

  return (
    <div>
      <h1>Room Page</h1>
      <p>okay</p>
      <h4>{remoteSocketId ? "Connected" : "No one in room"}</h4>
      {myStream && <button onClick={sendStreams}>Send Stream</button>}
      {remoteSocketId && <button onClick={handleCallUser}>CALL</button>}
      {myStream && (
        <>
          <h1>My Stream</h1>
          <ReactPlayer
            playing
            muted
            height="100px"
            width="200px"
            url={myStream}
          />
        </>
      )}
      {remoteStream && (
        <>
          <h1>Remote Stream</h1>
          <ReactPlayer
            playing
            muted={false}
            height="100px"
            width="200px"
            url={remoteStream}
          />
        </>
      )}
      {remoteStream && (
        <>
          <h3>Transcript:</h3>
          <p>{transcript}</p>
        </>
      )}
      {summary && (
        <>
          <h3>Meeting Summary:</h3>
          <p>{summary}</p>
        </>
      )}
      {!recognizer && <p>Loading Vosk Model...</p>}
      {callActive && (
        <button
          onClick={handleEndCall}
          style={{
            backgroundColor: "red",
            color: "white",
            padding: "10px",
            marginTop: "10px",
          }}
        >
          End Call
        </button>
      )}
    </div>
  );
};

export default RoomPage;
