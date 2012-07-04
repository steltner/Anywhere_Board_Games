
/* Once thing we don't really have here is an object representing the model of
 * the world. Right now we let the piece_ui utilize the piece objects that are
 * generated by the DOM to hold all of the model status.  If we start allowing
 * client side zooming, or other interesting changes, this could be a problem.
 * On the other hand, since z-indexing requires special care (to avoid long term
 * holes), we'd have to pick up that responsibility.
 * 
 * Another interesting issue is that we have specialized functions for moving,
 * locking, etc.  Moving was split out so that we could send multiple close 
 * move commands, and allow the resulting ajax not pile up.  Instead we could
 * replace almost all of these functions with a general world_piece_model_update
 * or even a world_model_update function that could take an array of the changes
 * and act accordingly.
 */

// Keep track of the largest index we use for a piece with the server
var world_max_piece_index = -1;

// For now, use the local PHP server to share world data
var world_server_url = "../server/world.php";

// Hold the current local state
var world_local_state = {};

/*
 * world_get_new_piece_index - Gets the index of the next piece to be added
 * to the world.
 * 
 * TODO: LOW -  There is a small race condition if two pieces are added simultaneously
 * TODO: LOW - Fill in any null holes from previously deleted pieces first
 */
function world_get_new_piece_index(){
	world_max_piece_index ++;
	return world_max_piece_index;
}

/*
 * world_add_piece - Adds a piece to the world server
 * 
 * @param piece_data Object containing new piece data
 */
function world_add_piece(piece_data){
	var piece_index = world_get_new_piece_index();
	world_update_piece(piece_index,piece_data);
}

/*
 * flatten_recursive_structure - This takes a structured recursive array/object
 * and turns it into a single associative array (using "|" to separate
 * keys) suitable for use in Google Hangout state
 * 
 * @param update The update to the world
 * @param base_key (defaults to "") used for recursion
 * @param flat_update (defaults to {}) used for recursion
 */
function flatten_recursive_structure(update, base_key, flat_update){
	base_key = (typeof base_key !== 'undefined') ? base_key : "";
	flat_update = (typeof flat_update !== 'undefined') ? flat_update : {};

	if ($.isArray(update) || $.isPlainObject(update)){
		$.each(update, function(k, e){
			var new_key = base_key ? (base_key + "|" + k) : k;
			if ($.isArray(e) || $.isPlainObject(e)){
				flatten_recursive_structure(e, new_key, flat_update);
			} else {
				// TODO HANDLE NULL VALUES BY REMOVING THEM FROM THE WORLD
				if ((e == null) || (e == undefined)){
					flat_update[new_key] = "_NULL_";
					alert("delete not working yet");
				} else {
					flat_update[new_key] = e.toString();
				}
			}
		});
	}
	return (flat_update);
}

/*
 * unflatten_recursive_structure - This a flattened associative array
 * and returns it to a structured recursive array/object.
 * 
 * @param flat_update The flattened update
 */
function unflatten_recursive_structure(flat_update){
	var update = {};

	function compoundkey_set(u, k, v){
		k = k.split("|");
		var f = k.shift();
		while (k.length > 0){
			if (!(u[f] instanceof Object)){
				// Create object for parent of not there
				u[f] = {};
			}
			u = u[f];
			f = k.shift();
		}
		if (v == "_NULL_"){
			// TODO: HANDLE DELETES
			u[f] = null;
		} else {
			u[f] = v;
		}
	}

	// TODO: DETERMINE IF WE REALLY NEED TO SORT KEYS IF WE ASSUME EVERYTHING IS AN OBJECT
	// Grab the keys
	var keys = [];
	$.each(flat_update, function(k, v){
		keys.push(k);
	});
	// Now sort the keys
	keys.sort();
	// Now loop through the keys and setting the update object (so we hit parents before children)
	$.each(keys, function(i, k){
		compoundkey_set(update, k, flat_update[k]);
	});
	return (update);
}

/*
 * world_update - Sends an update array to the world.  Any subsequent calls will be 
 * combined into a single update until the previous ajax call is completed.
 * 
 * @param update The update to implement in the world
 */
function world_update(update){
	console.log(JSON.stringify(update));
	console.log(JSON.stringify(flatten_recursive_structure(update)));
	gapi.hangout.data.submitDelta(flatten_recursive_structure(update));
}

/*
 * world_update_piece - Convenience function to update a piece given a piece
 * index and an array of attributes
 * 
 * @param piece_index Index of the peice to update
 * @param piece_update Object containing the attributes to update 
 */
function world_update_piece(piece_index, piece_update){
	var update = {
		"pieces": new Object()
	};
	update.pieces[piece_index] = piece_update;
	world_update(update);
}

/*
 * world_update_piece_accumulate - Accumulates piece updates until
 * world_update_piece_accumulate_flush is called.  This is useful for easily
 * updating many pieces at once.  Changes to the same piece will
 * completely overwrite old ones.
 * 
 * @param piece_index Index of the peice to update
 * @param piece_update Object containing the attributes to update 
 */
function world_update_piece_accumulate(piece_index, piece_update){
	if (!("update" in world_update_piece_accumulate)){
		world_update_piece_accumulate.update = {
			"pieces": new Object()
		};
	}
	world_update_piece_accumulate.update.pieces[piece_index] = piece_update;
}

/*
 * world_update_piece_accumulate_flush - Sends any accumulated piece updates
 * gathered in world_update_piece_accumulate() to the server.
 */
function world_update_piece_accumulate_flush(){
	if ("update" in world_update_piece_accumulate) {
		world_update(world_update_piece_accumulate.update);
		delete world_update_piece_accumulate.update;
	}
}

/*
 * world_on_new_piece_handler - This is a handler function(piece_index, piece_data)
 * that is set by the code interested in listening to piece additions to the world
 * When a new piece is added, the piece_index is set to the index used by the world
 * to reference changes (the index for the change handler in 
 * world_on_piece_change_handlers) and piece_data is an array holding any changed
 * data for the piece.
 */
var world_on_new_piece_handler = function(){};

/*
 *  world_on_piece_change_handlers - This is an array of change handlers 
 *  function(piece_data) that is set by the code interested in listening
 *  to piece changes.  The array is indexed by the piece_index (see
 *  world_on_new_piece_handler).
 */
var world_on_piece_change_handlers = {};

function execute_world_update(update){
	var piece_index;
	// Handle a new world
	if ((!(update instanceof Object)) || ("__new" in update)) {
		// Reset max piece index
		world_max_piece_index = -1;
		// Delete existing pieces
		for (piece_index in world_on_piece_change_handlers){
			world_on_piece_change_handlers[piece_index](null);
			// Unregister the handler
			delete world_on_piece_change_handlers[piece_index];
		}
		// Now add new pieces
		if ((update instanceof Object) && ("pieces" in update)){
			for (piece_index in update.pieces) {
				if (Number(piece_index) > world_max_piece_index){
					world_max_piece_index = Number(piece_index);
				}
				// Add the piece if it isn't null
				if (update.pieces[piece_index] instanceof Object){
					world_on_new_piece_handler(piece_index, update.pieces[piece_index]);
				}
			}
		}
	} else if ("pieces" in update) {
		// Iterate pieces, looking for new, updates, or deletes
		for (piece_index in update.pieces) {
			if ((update.pieces[piece_index] instanceof Object) && 
				(!(Number(piece_index) in world_on_piece_change_handlers))) {
				if (Number(piece_index) > world_max_piece_index){
					world_max_piece_index = Number(piece_index);
				}
				world_on_new_piece_handler(piece_index, update.pieces[piece_index]);
			} else if (piece_index in world_on_piece_change_handlers){
				world_on_piece_change_handlers[piece_index](update.pieces[piece_index]);
				// Check if the piece was deleted
				if (update.pieces[piece_index] === null){
					// Unregister the handler
					delete world_on_piece_change_handlers[piece_index];
				}
			}
		}
	}
}

/*
 * world_listener_start - Implements an loop that checks for updates from
 * the world server.  It calls "execute_world_update" if there is an update.
 */
function world_listener_start(){
	// TODO - Read initial state

	// When the state is updated, this handles the update data
	var world_update_handler = function(eventObj){
		var flat_update = {};
		var i, k, v;
		for (i = 0; i < eventObj.addedKeys.length; ++i){
			k = eventObj.addedKeys[i].key;
			v = eventObj.addedKeys[i].value;
			flat_update[k] = v;
			world_local_state[k] = v;
		}
		// TODO: HANDLE REMOVED KEYS
		for (i = 0; i < eventObj.removedKeys.length; ++i){
			k = eventObj.removedKeys[i].key;
		}
		var update = unflatten_recursive_structure(flat_update);
		console.log(JSON.stringify(update));
		execute_world_update(update);
	}
	// Register our update andler
	gapi.hangout.data.onStateChanged.add(world_update_handler);
}

// Start the world listener
gapi.hangout.onApiReady.add(function(eventObj){
  if (eventObj.isApiReady){
    world_listener_start();	  
  }
});