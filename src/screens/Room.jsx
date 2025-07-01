import React, { useEffect, useCallback, useState } from "react";
import ReactPlayer from "react-player";
import peer from "../service/peer";
import { useSocket } from "../context/SocketProvider";
import Groq from "groq-sdk";

const RoomPage = () => {
  const socket = useSocket();
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [myStream, setMyStream] = useState();
  const [remoteStream, setRemoteStream] = useState();
 

const [myRecognizer, setMyRecognizer] = useState(null);
const [remoteRecognizer, setRemoteRecognizer] = useState(null);

const [myTranscript, setMyTranscript] = useState("");
const [remoteTranscript, setRemoteTranscript] = useState("");
const [finalTranscript, setFinalTranscript] = useState("");
const [isAnalyzing, setIsAnalyzing] = useState(false);

const [summary, setSummary] = useState("");
// Room.jsx (model-loading part)

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

      const myRec = new model.KaldiRecognizer(16000);
      const remoteRec = new model.KaldiRecognizer(16000);

      myRec.on("result", msg => {
        const text = msg.result.text;
        setMyTranscript(prev => prev + " " + text);
        setFinalTranscript(prev => prev + `\n[You]: ${text}`);
      });

      remoteRec.on("result", msg => {
        const text = msg.result.text;
        setRemoteTranscript(prev => prev + " " + text);
        setFinalTranscript(prev => prev + `\n[Remote]: ${text}`);
      });

      setMyRecognizer(myRec);
      setRemoteRecognizer(remoteRec);
    } catch (err) {
      console.error("Vosk failed to load:", err);
    }
  })();
}, []);





 useEffect(() => {
  if (!myStream || !myRecognizer) return;
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(myStream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);

  proc.onaudioprocess = e => {
    try {
      myRecognizer.acceptWaveform(e.inputBuffer);
    } catch (err) {
      console.error("Vosk error (my stream):", err);
    }
  };

  src.connect(proc);
  proc.connect(audioCtx.destination);
  return () => {
    proc.disconnect();
    src.disconnect();
    audioCtx.close();
  };
}, [myStream, myRecognizer]);

useEffect(() => {
  if (!remoteStream || !remoteRecognizer) return;
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(remoteStream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);

  proc.onaudioprocess = e => {
    try {
      remoteRecognizer.acceptWaveform(e.inputBuffer);
    } catch (err) {
      console.error("Vosk error (remote stream):", err);
    }
  };

  src.connect(proc);
  proc.connect(audioCtx.destination);
  return () => {
    proc.disconnect();
    src.disconnect();
    audioCtx.close();
  };
}, [remoteStream, remoteRecognizer]);
useEffect(() => {
  return () => {
    if (myStream) {
      myStream.getTracks().forEach(track => track.stop());
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
    }
  };
}, [myStream, remoteStream]);

const analyzeTranscript = useCallback(async () => {
  setIsAnalyzing(true);
  try {
    const res = await fetch("https://serverless-groq-endpoint.vercel.app/api/server", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript: finalTranscript }),
    });

    const data = await res.json();
    if (data.summary) {
      console.log("Groq Summary:", data.summary);
      setSummary(data.summary);
    } else {
      console.error("Groq returned no summary", data);
    }
  } catch (err) {
    console.error("Error analyzing transcript:", err);
  } finally {
    setIsAnalyzing(false);
  }
}, [finalTranscript]);



  const handleUserJoined = useCallback(({ email, id }) => {
    console.log(`Email ${email} joined room`);
    setRemoteSocketId(id);
  }, []);

  const handleCallUser = useCallback(async () => {
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
    peer.peer.addEventListener("track", async (ev) => {
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

    return () => {
      socket.off("user:joined", handleUserJoined);
      socket.off("incomming:call", handleIncommingCall);
      socket.off("call:accepted", handleCallAccepted);
      socket.off("peer:nego:needed", handleNegoNeedIncomming);
      socket.off("peer:nego:final", handleNegoNeedFinal);
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
          <h3>Live Transcript (You):</h3>
<p>{myTranscript}</p>

<h3>Live Transcript (Remote):</h3>
<p>{remoteTranscript}</p>


<button onClick={analyzeTranscript} disabled={!finalTranscript || isAnalyzing}>
  {isAnalyzing ? "Analyzing..." : "Analyze Transcript (Groq)"}
</button>
{summary && (
  <>
    <h3>Meeting Summary:</h3>
    <p>{summary}</p>
  </>
)}


        </>
      )}
    {(!myRecognizer || !remoteRecognizer) && <p>Loading Vosk Model...</p>}


    </div>
  );
};

export default RoomPage;
