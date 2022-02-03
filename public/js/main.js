'use strict';

var isChannelReady = false;
var isInitiator = false;
var isStarted = false;
const MAX_RDC_LENGTH = 262144; // MTU in WebRTC Data Channel
const MAX_SEGMENT_LENGTH = 262000;
const MAX_RDC_BUF_AMT = 16000000;
const MAX_RDC_ID = 65535;
// var localStream;
var pc;
var remoteStream;
var turnReady;
var pc_stream_channel;
var next_stream_channel;
var last_frame;
var last_frame_no;
var active_DC = 0;

class payloadStruct {
  payloadStruct(data, type, msg_segment, total_segments) {
    this.data = data;
    this.type = type;
    this.msg_segment = msg_segment;
    this.total_segments = total_segments;
  }

  setData(data) {
    this.data = data;
  }

  stringify() {
    return JSON.stringify({ data: this.data, type: this.type, msg_segment: this.msg_segment, total_segments: this.total_segments })
  }
}

var pcConfig = {
  'iceServers': [{
    'urls': 'stun:stun.l.google.com:19302'
  }]
};

// Set up audio and video regardless of what devices are present.
var sdpConstraints = {
  offerToReceiveAudio: true,
  offerToReceiveVideo: true
};

///////////////////////////////////////////// 
// START ROS Code
// Connecting to ROS
// -----------------

var ros = new ROSLIB.Ros();

// Create a connection to the rosbridge WebSocket server.
ros.connect('ws://localhost:9090');

ros.on('connection', function () {
  console.log('Connected to websocket server.');
});

ros.on('error', function (error) {
  console.log('Error connecting to websocket server: ', error);
});

ros.on('close', function () {
  console.log('Connection to websocket server closed.');
});

// Publishing a Topic
// ------------------

var publisher = new ROSLIB.Topic({
  ros: ros,
  name: '/b2n_data',
  messageType: 'std_msgs/String'
});

// publisher.publish(data);

//Subscribing to a Topic
//----------------------

// Like when publishing a topic, we first create a Topic object with details of the topic's name
// and message type. Note that we can call publish or subscribe on the same topic object.
var listener = new ROSLIB.Topic({
  ros: ros,
  name: '/n2b_data',
  serviceType: 'std_msgs/String'
});

// Then we add a callback to be called every time a message is published on this topic.
listener.subscribe(function (message) {
  // console.log('Received message on ' + listener.name + ': ' + message.data);

  // switch to new RTC DC when bufferedAmount 
  if (pc_stream_channel.bufferedAmount > MAX_RDC_BUF_AMT) {
    var temp = pc_stream_channel;
    pc_stream_channel = next_stream_channel;
    console.log(`switched to DC [${pc_stream_channel.id}]`);
    temp.close();
    next_stream_channel = createRTCDataChannel();
  }

  if (pc_stream_channel.readyState === 'open') {
    var no_of_chunks = Math.ceil(message.data.length / MAX_SEGMENT_LENGTH);
    for (let curr_pos = 0; curr_pos <= message.data.length; curr_pos += MAX_SEGMENT_LENGTH) {
      // payload contains {data, type, msg_segment, total_segments}
      var payload = {
        data: message.data.substring(curr_pos, curr_pos + MAX_SEGMENT_LENGTH),
        type: 'b64/octree',
        msg_segment: Math.ceil(curr_pos / MAX_SEGMENT_LENGTH),
        total_segments: no_of_chunks
      };
      console.log(JSON.stringify(payload).length)
      try {
        pc_stream_channel.send(JSON.stringify(payload));
      } catch (e) {
        console.log(e)
      }
    }
  }
});

// END ROS Code
/////////////////////////////////////////////

var room = 'foo';
// Could prompt for room name:
room = prompt('Enter room name:');

var socket = io.connect();

if (room !== '') {
  socket.emit('create or join', room);
  console.log('Attempted to create or  join room', room);
}

socket.on('created', function (room) {
  console.log('Created room ' + room);
  isInitiator = true;
});

socket.on('full', function (room) {
  console.log('Room ' + room + ' is full');
});

socket.on('join', function (room) {
  console.log('Another peer made a request to join room ' + room);
  console.log('This peer is the initiator of room ' + room + '!');
  isChannelReady = true;
  gotStream()
});

socket.on('joined', function (room) {
  console.log('joined: ' + room);
  isChannelReady = true;
});

socket.on('log', function (array) {
  console.log.apply(console, array);
});

////////////////////////////////////////////////
// Data Channel Initialization and EventListener Initialization
function createRTCDataChannel() {
  const channel = pc.createDataChannel("pc_stream", { negotiated: true, id: (active_DC++)%MAX_RDC_ID, ordered: true, maxRetransmits: 0 });

  // onopen event
  channel.onopen = function (event) {
    console.log(`RTC Data Channel [${event.currentTarget.id}] opened`);
    // console.log(event);
  }

  // onmessage event
  channel.onmessage = function (event) {
    var msg;
    try {
      msg = JSON.parse(event.data);
      if (msg.type === 'b64/octree') {
        last_frame += msg.data;
        last_frame_no = msg.msg_segment;
        if (last_frame_no === msg.total_segments - 1) {
          console.log(last_frame.length)
          // Publishing to /live_data rostopic
          var pub_msg = new ROSLIB.Message({ data: last_frame })
          publisher.publish(pub_msg);
          last_frame = "";
        }
      } else {
        console.log(event.data)
      }
    } catch (e) {
      console.info(event.data);
    }
  }
  channel.onclose = function (event) {
    console.log(`closed DC [${event.currentTarget.id}]`)
  }

  return channel;
}

function setRTCDC_events(channel) {

}

function sendMessage(message) {
  console.log('Client sending message: ', message);
  socket.emit('message', message);
}

////////////////////////////////////////////////

socket.on('data_stream', function (message) {
  console.log(message.length);
  message = JSON.parse(message);

  if (message.type == 'pc_stream') {
    console.log(message.data);
  }
})

// This client receives a message
socket.on('message', function (message) {
  // console.log('Client received message:', message);
  if (message === 'got user media') {
    maybeStart();
  } else if (message.type === 'pc_stream') {
    // Publish to /live_data rostopic
    console.log(message.data);
    publisher.publish(message.data);
  } else if (message.type === 'offer') {
    if (!isInitiator && !isStarted) {
      maybeStart();
    }
    pc.setRemoteDescription(new RTCSessionDescription(message));
    doAnswer();
  } else if (message.type === 'answer' && isStarted) {
    pc.setRemoteDescription(new RTCSessionDescription(message));
  } else if (message.type === 'candidate' && isStarted) {
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: message.label,
      candidate: message.candidate
    });
    pc.addIceCandidate(candidate);
  } else if (message === 'bye' && isStarted) {
    handleRemoteHangup();
  }
});

////////////////////////////////////////////////////

var localVideo = document.querySelector('#localVideo');
var remoteVideo = document.querySelector('#remoteVideo');

// navigator.mediaDevices.getUserMedia({
//   audio: false,
//   video: false
// })
//   .then(gotStream)
//   .catch(function (e) {
//     alert('getUserMedia() error: ' + e.name);
//   });

function gotStream() {
  // console.log('Adding local stream.');
  sendMessage('got user media');
  if (isInitiator) {
    maybeStart();
  }
}

var constraints = {
  video: false
};

console.log('Getting user media with constraints', constraints);

if (location.hostname !== 'localhost') {
  requestTurn(
    'https://computeengineondemand.appspot.com/turn?username=41784574&key=4080218913'
  );
}

function maybeStart() {
  console.log('>>>>>>> maybeStart() ', isStarted, isChannelReady);
  if (!isStarted && isChannelReady) {
    console.log('>>>>>> creating peer connection');
    createPeerConnection();
    pc_stream_channel = createRTCDataChannel();
    next_stream_channel = createRTCDataChannel();
    // pc.addStream(localStream);
    isStarted = true;
    console.log('isInitiator', isInitiator);
    if (isInitiator) {
      doCall();
    }
  }
}

window.onbeforeunload = function () {
  sendMessage('bye');
};

/////////////////////////////////////////////////////////

function createPeerConnection() {
  try {
    pc = new RTCPeerConnection(pcConfig);
    pc.onicecandidate = handleIceCandidate;
    pc.ontrack = handleRemoteStreamAdded;
    pc.onremovestream = handleRemoteStreamRemoved;
    console.log('Created RTCPeerConnnection');
  } catch (e) {
    console.log('Failed to create PeerConnection, exception: ' + e.message);
    alert('Cannot create RTCPeerConnection object.');
    return;
  }
}

function handleIceCandidate(event) {
  console.log('icecandidate event: ', event);
  if (event.candidate) {
    sendMessage({
      type: 'candidate',
      label: event.candidate.sdpMLineIndex,
      id: event.candidate.sdpMid,
      candidate: event.candidate.candidate
    });
  } else {
    console.log('End of candidates.');
  }
}

function handleCreateOfferError(event) {
  console.log('createOffer() error: ', event);
}

function doCall() {
  console.log('Sending offer to peer');
  pc.createOffer(setLocalAndSendMessage, handleCreateOfferError);
}

function doAnswer() {
  console.log('Sending answer to peer.');
  pc.createAnswer().then(
    setLocalAndSendMessage,
    onCreateSessionDescriptionError
  );
}

function setLocalAndSendMessage(sessionDescription) {
  pc.setLocalDescription(sessionDescription);
  console.log('setLocalAndSendMessage sending message', sessionDescription);
  sendMessage(sessionDescription);
}

function onCreateSessionDescriptionError(error) {
  trace('Failed to create session description: ' + error.toString());
}

function requestTurn(turnURL) {
  var turnExists = false;
  for (var i in pcConfig.iceServers) {
    if (pcConfig.iceServers[i].urls.substr(0, 5) === 'turn:') {
      turnExists = true;
      turnReady = true;
      break;
    }
  }
  if (!turnExists) {
    console.log('Getting TURN server from ', turnURL);
    // No TURN server. Get one from computeengineondemand.appspot.com:
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4 && xhr.status === 200) {
        var turnServer = JSON.parse(xhr.responseText);
        console.log('Got TURN server: ', turnServer);
        pcConfig.iceServers.push({
          'urls': 'turn:' + turnServer.username + '@' + turnServer.turn,
          'credential': turnServer.password
        });
        turnReady = true;
      }
    };
    xhr.open('GET', turnURL, true);
    xhr.send();
  }
}

function handleRemoteStreamAdded(event) {
  console.log('Remote stream added.');
  remoteStream = event.stream;
  remoteVideo.srcObject = remoteStream;
}

function handleRemoteStreamRemoved(event) {
  console.log('Remote stream removed. Event: ', event);
}

function hangup() {
  console.log('Hanging up.');
  stop();
  sendMessage('bye');
}

function handleRemoteHangup() {
  console.log('Session terminated.');
  stop();
  isInitiator = false;
}

function stop() {
  isStarted = false;
  pc.close();
  pc = null;
}
