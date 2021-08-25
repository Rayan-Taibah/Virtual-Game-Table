/**
 * This file is part of the Virtual Game Table distribution 
 * Copyright (c) 2015-2021 Jack Childress (Sankey).
 * 
 * This program is free software: you can redistribute it and/or modify  
 * it under the terms of the GNU General Public License as published by  
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but 
 * WITHOUT ANY WARRANTY; without even the implied warranty of 
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU 
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License 
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */


// Everything about the current game state that can be sent in a data packet
// see also reset_game();
var state = {
  clients: {},              // List of client data
  pieces : {},              // List of piece properties
  hands  : {},              // list of hand properties
  t_simulated_lag : 0,      // Simulated lag when routing packets.
  t_full_update   : 4000,   // How often to send a full update
}; 

// State keys that should not be set by clients with server commands (/set)
var state_keys_no_set = [
  'clients', 
  'pieces', 
  'hands',
];



// Versions included in external_scripts
jquery_version    = 'jquery-3.5.1.min.js';
pixi_version      = 'pixi.min.js';
howler_version    = 'howler.min.js';

// requirements
var fs   = require('fs');                     // file system stuff
var app  = require('express')();              // routing handler
var http = require('http').createServer(app); // listening
var io   = require('socket.io')(http);        // fast input/output
var fun  = require('./common/fun');           // My common functions

// Set the initial state without messing up the clients
function reset_game() {
  fun.log_date('Resetting game...');

  // Reset the key components
  state.pieces = {};
  state.hands  = {};

  // Now send all the clients this info
  for(id in state.clients) send_state(id);
}
reset_game();


// port upon which the server listens
fun.log_date('');
fun.log_date('Arguments:');
for(var n in process.argv) fun.log_date(process.argv[n]);

// find out if a game name and port was supplied
game_name = process.argv[2];
port      = parseInt(process.argv[3]);

if(game_name == '0') game_name = 'puerto-rico';
if(port      ==  0 ) port      = 38000;

// get the directories
var root_directory = process.cwd();

// This is the order of searching for files.
var private_directory  = root_directory + '/private/'  + game_name
var games_directory    = root_directory + '/games/'    + game_name;
var common_directory   = root_directory + '/common';

// change to the root directory
fun.log_date('');
fun.log_date('Search Order:');
fun.log_date('  '+private_directory);
fun.log_date('  '+games_directory);
fun.log_date('  '+common_directory);
fun.log_date('  '+root_directory+'\n');

/**
 * See if the full path exists.
 * @param {string} path 
 */
function file_exists(path) { return fs.existsSync(path); }

/**
 * Returns the path to the appropriate file, following the priority
 * private_directory, games_directory, common_directory
 */
function find_file(path) {
  //fun.log_date(' Searching for', path, 'in');
  var paths = [
    private_directory +'/'+path,
    games_directory   +'/'+path,
    common_directory  +'/'+path,
    root_directory    +'/'+path
  ] 
  
  for(var n in paths) {if(file_exists(paths[n])) return paths[n];}

  fun.log_date('  FILE NOT FOUND:', path);
  return common_directory+'/images/nofile.png';
}

/**
 * Searches for the path, and, if found, sends it using the response object
 * @param {response} response
 * @param {path-like string} path 
 */
function send_file(response, path) {
  var full_path = find_file(path);
  fun.log_date('  Sending ', full_path);
  if(full_path) response.sendFile(full_path);
}

function html_encode(s) {
  // Thanks Stack Exchange.
  return s.replace(/[\u00A0-\u9999<>\&]/gim, function(i) {return '&#'+i.charCodeAt(0)+';';});
}



///////////////////
// FILE REQUESTS //
///////////////////

// External Scripts
app.get('/external_scripts/pixi.js', function(request, response) {
  response.sendFile(root_directory + '/external_scripts/' + pixi_version); } );

app.get('/socket.io.js', function(request, response) {
  response.sendFile(root_directory + '/node_modules/socket.io-client/dist/socket.io.js'); } );

app.get('/socket.io.js.map', function(request, response) {
  response.sendFile(root_directory + '/node_modules/socket.io-client/dist/socket.io.js.map'); } );
  
app.get('/external_scripts/jquery.js', function(request, response) {
  response.sendFile(root_directory + '/external_scripts/' + jquery_version); } );

app.get('/external_scripts/howler.js', function(request, response) {
  response.sendFile(root_directory + '/external_scripts/' + howler_version); } );
  
app.get('/',          function(request, response) {send_file(response, 'index.html')    ;} );
app.get('/:f',        function(request, response) {send_file(response, request.params.f);} );

app.get('/:z/:i',       function(request, response) {send_file(response, request.params.z+'/'+request.params.i                                          );} );
app.get('/:z/:d/:i',    function(request, response) {send_file(response, request.params.z+'/'+request.params.d+'/'+request.params.i                     );} );
app.get('/:z/:a/:b/:c', function(request, response) {send_file(response, request.params.z+'/'+request.params.a+'/'+request.params.b+'/'+request.params.c);} );
app.get('/common/avatars/:i', function(request, response) {send_file(response, 'common/avatars/' +request.params.i);} );
app.get('/private/avatars/:i',function(request, response) {send_file(response, 'private/avatars/'+request.params.i);} );



////////////////////////////
// Lag simulator
////////////////////////////

/**
 * Routes the supplied data to the supplied handler function after a delay.
 * @param {function} handler // Function that receives the data after state.t_simulated_lag
 * @param {*} data           // Incoming data.
 */
function delay_function(handler, data) {

  // If we have a simulated lag, delay the handling of this data
  // Note I think it would be a bad simulation if we allow this lag to vary here,
  // because this would re-order the data, which is ensured to be in order by the TCP 
  // protocol.
  if(state.t_simulated_lag) setTimeout(function(){handler(data)}, state.t_simulated_lag);
  
  // Otherwise, just run the handler on the data.
  else handler(data);
}

/**
 * Emits the data on the supplied socket with the supplied key, after a delay (if not zero).
 * @param {socket} socket 
 * @param {String} key 
 * @param {*} data 
 */
function delay_send(socket, key, data) {
  if(socket) {
    if(state.t_simulated_lag) setTimeout(function(){socket.emit(key,data)}, t_simulated_lag);
    else                                            socket.emit(key,data);
  }
}



///////////////////////////////////////////
// Thread for what to do with new client //
///////////////////////////////////////////

var sockets     = {}; // Socket objects, sorted by id
var last_id     = 1;  // Last assigned id; incremented with each client

// Names for new players
var first_names = ['pants', 'n00b', '1337', 'dirt', 
                   'trash', 'no', 'terrible', 'nono'];
var last_names  = ['tastic', 'cakes', 'pants', 'face', 'n00b', 'juice', 
                   'bag', 'hole', 'friend', 'skillet', 'person'];

// Sends the game state to the specified client id
function send_state(id) {
  fun.log_date('NETS_state to', id);

  // Send it
  delay_send(sockets[id], 'state', [id, state]);
}     





// When a client connects
io.on('connection', function(socket) {

  // Put the id somewhere safe.
  socket.id = last_id++;

  // Save this socket, sorted by id
  sockets[socket.id] = socket;

  /** 
   * My own function that sends the supplied data to everyone else; 
   * socket.broadcast.emit is not working right. 
   */
  function broadcast(key, data) {
    for (id in state.clients) 
      if(id != socket.id) delay_send(sockets[id], key, data);
  }

  // Add a new client to the list
  if(state.clients) {
    state.clients[socket.id] = {
      'id'     : socket.id, 
      'name'   : fun.random_array_element(first_names)+fun.random_array_element(last_names),
      'team'   : 0,
    };
    fun.log_date('CLIENT', socket.id, 'CONNECTED');
  } 
  else fun.log_date('ERROR: state.clients does not exist!');
  
  // Summarize existing state.clients
  for(n in state.clients) fun.log_date(' ', n, state.clients[n]);

  ////////////////////////////
  // Queries sent by client
  ////////////////////////////

  // Client says hello, asks for game state.
  function on_hallo(data) {
    fun.log_date(socket.id, 'NETR_hallo', data);
    var name = data[0]; // string
    var team = data[1]; // integer
    
    // Update the client name
    if(name != '' && socket && state.clients) state.clients[socket.id].name = name;
    if(              socket && state.clients) state.clients[socket.id].team = team;

    // Send the full game state
    send_state(socket.id);

    // Tell everyone else just the client list (socket.brodcast.emit is not working)
    broadcast('clients', state.clients);
  }
  socket.on('hallo', function(data) {delay_function(on_hallo, data)});


  // Team or name change from clients
  function on_clients(clients) {
    fun.log_date('NETR_clients_'+String(socket.id));

    // Update the clients list
    if(clients) state.clients = clients;
    else fun.log_date('  ERROR: no clients provided!');

    // Send the game state
    delay_send(io, 'clients', clients);
  }
  socket.on('clients', function(data) {delay_function(on_clients, data)});



  // received a chat message
  function on_chat(message) {
    fun.log_date(socket.id, 'Received-chat:', socket.id, state.clients[socket.id].name, message);

    // If the message starts with "/" it's a server command
    if(message[0]=='/') {

      // Split it by space
      var s = message.split(' ');

      // Reset to defaults
      if(s[0] == '/reset') reset_game();

      // Boot client by name
      else if(s[0] == '/boot') {

        // Find the client by name and boot them
        for(var id in state.clients) if(state.clients[id].name == s[1]) {
          delay_send(io, 'chat', [0, 'Booting ' + s[1] + '.']);
          sockets[id].emit('yabooted');
          sockets[id].disconnect(true);
        }
      }

      // Set a variable
      else if(s[0] == '/set') {

        // If we can set it
        if(s[1] in state && !state_keys_no_set.includes(s[1]) && s.length==3) {
        
          // Update
          state[s[1]] = parseFloat(s[2]);

          // Remember for next time
          state_defaults[s[1]] = state[s[1]];

          // Send the state to everyone
          for(var id in sockets) send_state(id);
        }

        // Send the current settings.
        s = 'OPTIONS:';
        for(var key in state) if(!state_keys_no_set.includes(key)) s = s + '\n' + key + ' ' + state[key];
        delay_send(socket, 'chat', [socket.id,s]);
      }
    } // end of "message starts with /"

    // Send a normal chat
    else delay_send(io, 'chat', [socket.id,html_encode(message)]);
  }
  socket.on('chat', function(data) {delay_function(on_chat, data)});

  // Player says something. data = [player_index, key, interrupt]
  function on_say(data) {
    fun.log_date('NETR_say_'+String(socket.id), data);
    
    // Relay it to everyone else
    broadcast('say', data);
  }
  socket.on('say', function(data) {delay_function(on_say, data)});



  // Client has sent a list of z moves of the form [id,z,id,z,id,z,...]
  function on_z(data) { fun.log_date('NETR_z_'+String(socket.id), data.length/2); 

    var id_piece, c, l, zi, zf;

    // Loop over the entries
    for(var n=0; n<data.length; n+=2) {

      // Unpack
      id_piece = data[n];
      c        = state.pieces[id_piece] // incoming piece data
      if(!c) continue;                  // Only happens if someone has the wrong number of pieces compared to the server.
      l        = c['l'];                // Layer
      zi       = c['z'];                // Initial z-position
      zf       = data[n+1];             // Final z-position
      
      // If zf > zi 
      //   p.z < zi         no change
      //   p.z == zi        set to zf
      //   zi < p.z <= zf   subtract one
      //   p.z > zf         no change
      
      // If zi > zf
      //   p.z < zf         no change
      //   zf <= p.z < zi   add one
      //   p.z == zi        set to zf
      //   p.x > zi         no change

      // Now that we have the zi and zf, loop over the state pieces, updating the z's of those in the layer.
      var p;
      for(var i in state.pieces) if(l == state.pieces[i]['l']) { p = state.pieces[i];

        // Do different numbering depending on where the z is relative to the initial and final values.
        
        // No matter what, if the z matches the initial z, this is the one to set
        if(p.z == zi) { p.z = zf; }
        
        // If zf > zi, we're moving it up in z order, so the middle numbers shift down.
        else if(zi < p.z && p.z <= zf) { p.z--; }

        // If zi > zf, we're moving it lower, so the middle numbers shift up
        else if(zf <= p.z && p.z < zi) { p.z++; }
      }

    } // End of loop over entries

    // Relay this move to everyone, including the sender.
    delay_send(io, 'z', data);
  }
  socket.on('z', function(data) {delay_function(on_z, data)});



  // Client has sent a q of changes
  function on_q(data) { fun.log_date('NETR_q_'+String(socket.id), 'nq =', data[0], 'with', Object.keys(data[1]).length, 'Pieces', Object.keys(data[2]).length, 'Hands');
    var nq       = data[0];
    var q_pieces = data[1];
    var q_hands  = data[2];
    var k, update_server_piece;

    // Loop over the incoming pieces q by id.
    for(var id in q_pieces) { 

      // Make sure we have a place to hold the data in the global list
      if(!state.pieces[id]) state.pieces[id] = {};

      // First make sure the holder exists in the current socket list
      if( state.pieces[id]['ih'] // If there is a holder id provided
      && !Object.keys(sockets).includes(String(state.pieces[id]['ih'])) ) {
        delete state.pieces[id]['ih'];
        delete state.pieces[id]['ih.i'];
        delete state.pieces[id]['ih.n'];
      }

      // If no one is hold it (0 or undefined) OR the holder is this client, set a flag to update the server state for this piece
      // Otherwise, we update the incoming q_pieces state with that of the server
      update_server_piece = !state.pieces[id]['ih'] || state.pieces[id]['ih'] == socket.id;    

      // Loop over attributes and transfer or defer to state, depending on who is holding the piece
      for(k in q_pieces[id]) {
        
        // If it is valid to update the server state for this piece
        if(update_server_piece) {

          // Update the state with the value, last setter, and last setter nq.
          state.pieces[id][k]      = q_pieces[id][k];
          state.pieces[id][k+'.i'] = q_pieces[id][k+'.i'] = socket.id;
          state.pieces[id][k+'.n'] = q_pieces[id][k+'.n'] = nq;
        }
        
        // Otherwise overwrite the q_pieces entry
        else {
          // Defer to the state's value, last setter, and last setter's nq
          q_pieces[id][k]      = state.pieces[id][k];
          q_pieces[id][k+'.i'] = state.pieces[id][k+'.i'];
          q_pieces[id][k+'.n'] = state.pieces[id][k+'.i'];
        }
      } // end of corrective loop over attributes
    } // end of loop over pieces


    // Loop over the hands q.
    for(var id in q_hands) {

      // Store the supplied properties
      if(!state.hands[id]) state.hands[id] = {};
      for(var k in q_hands[id]) state.hands[id][k] = q_hands[id][k];
    }

    delay_send(io, 'q', [socket.id, nq, q_pieces, q_hands]);
    //broadcast('q', [socket.id, q_pieces, q_hands]); // Leads to unsync
  }
  socket.on('q', function(data) {delay_function(on_q, data)});

  // handle the disconnect
  function on_disconnect(data) {
    // Get the id asap before it disappears (annoying)
    var id = socket.id;

    // find the client index
    fun.log_date(id, "disconnecting.", data);
    
    // Delete the client data. Socket will delete itself
    if(state.clients) delete state.clients[id];  

    // Delete the socket from the list
    if(sockets[id]) delete sockets[id];

    // tell the world!
    delay_send(io, 'clients', state.clients);
  }
  socket.on('disconnect', function(data) {delay_function(on_disconnect, data)});

}); // end of io.on('connection')



// Send a full update to everyone, excluding recently touched pieces
function send_full_update() { 

  // Send the queue if any sockets exist.
  if(sockets.length) {

    // Create a similar object to state.pieces, but without the unneeded information
    data = { ...state.pieces };
    for(id in data) { 
      delete data[id]['z.i']; 
      delete data[id]['z.n']; 
      delete data[id]['l.i'];
      delete data[id]['l.n'];
    }

    fun.log_date('send_full_update()', Object.keys(data).length, 'pieces');
    delay_send(io, 'q', [0, 0, data, {}]);
  }

  // Start the next full update
  setTimeout(send_full_update, state.t_full_update);

}; send_full_update(); // end / launch of send_full_update()


// actually start listening for requests
http.listen(port, function() {
  fun.log_date('listening on port '+String(port));
});
