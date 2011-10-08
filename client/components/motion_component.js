var STICK_THRESHOLD = 0.01,
    TOLERANCE       = 1e-6,
    COLLIDE_NONE    = 0,
    COLLIDE_STICK   = 1,
    COLLIDE_BOUNCE  = 2,
    COLLIDE_REST    = 3;

var framework = null;
exports.registerFramework = function(f) { framework = f; };

function computeTime(tick_count, state) {
  return Math.max(tick_count - state.start_tick, 0);
};

function getZeroVec(tick_count, state, r) {
  if(!r) {
    return [0.0,0.0,0.0];
  }
  for(var i=0; i<3; ++i) {
    r[i] = 0.0;
  }
  return r;
};

function setZeroVec(tick_count, state, v) {
  return [0.0,0.0,0.0];
};


var Models = {

  //Non-moving
  none: {
    getPosition: getZeroVec,
    setPosition: setZeroVec,
    getVelocity: getZeroVec,
    setVelocity: setZeroVec,
    params: [ 'model' ],
    checkDefaults: function(state) {
    }
  },

  //Constant model
  constant: {
  
    fastForward: function(tick_count, state) {
      return;
    },
  
    getPosition: function(tick_count, state, r) {
      if(!r) {
        return state.position.slice();
      }
      for(var i=0; i<3; ++i) {
        r[i] = state.position[i];
      }
      return r;
    },
    
    setPosition: function(tick_count, state, p) {
      for(var i=0; i<3; ++i) {
        state.position[i] = p;
      }
      return p;
    },
    
    getVelocity:  getZeroVec,
    setVelocity:  setZeroVec,
    
    params: [
      'model',
      'flags',
      'position',
    ],
    
    checkDefaults: function(motion) {
      if(!motion.position) {
        motion.position = [0.0,0.0,0.0];
      }
      if(!motion.flags) {
        motion.flags = {};
      }
    },
  },


  linear: {
  
    
    getPosition: function(tick_count, state, r) {
      var dt = computeTime(tick_count, state);
      if(!r) {
        r = [0.0,0.0,0.0];
      }
      for(var i=0; i<3; ++i) {
        r[i] = state.position[i] + dt * state.velocity[i];
      }
      return r;
    },
    
    setPosition: function(tick_count, state, p) {
      for(var i=0; i<3; ++i) {
        state.position[i] = p[i];
      }
      state.tick_start = tick_count;
      return p;
    },
    
    getVelocity: function(tick_count, state, r) {
      if(!r) {
        return state.velocity.slice();
      }
      for(var i=0; i<3; ++i) {
        r[i] = state.velocity[i];
      }
      return r;
    },
    
    setVelocity: function(tick_count, state, v) {
      Models.linear.getPosition(tick_count, state, state.position);
      for(var i=0; i<3; ++i) {
        state.velocity[i] = v[i];
      }
      state.start_tick = tick_count;
      return v;
    },
    
    fastForward: function(tick_count, state) {
      Models.linear.getPosition(tick_count, state, state.position);
      state.tick_start = tick_count;
    },
      
    params: [
      'model',
      'flags',
      'position',
      'velocity',
      'start_tick',
    ],
    
    checkDefaults: function(state) {
    
      Models['constant'].checkDefaults(state);
      if(!state.velocity) {
        state.velocity = [0.0,0.0,0.0];
      }
      if(!state.start_tick) {
        state.start_tick = 0;
      }    
    },
  },
  
  physical: {
    getPosition: function(tick_count, state, r) {
      if(!r) {
        r = [0.0,0.0,0.0];
      }
      var t  = computeTime(tick_count, state),
          a   = [0.0,0.0,0.0],
          mu  = Models.physical.getPhysicalParams(state, a),
          v  = state.velocity,
          p  = state.position;
          
      if(mu < TOLERANCE) {
        for(var i=0; i<3; ++i) {
          r[i] = (v[i] + 0.5*a[i]*t)*t + p[i];
        }
      }
      else {
        var f = 1.0 - Math.exp(-mu*t),
            u = -1.0/mu;
        for(var i=0; i<3; ++i) {
          r[i] = (a[i]*u - v[i])*u*f - a[i]*t*u + p[i];
        }
      }
      
      return r;
    },
    
    setPosition: function(tick_count, state, p) {
      Models.physical.getVelocity(tick_count, state, state.velocity);
      
      //console.log("Position fast forward velocity: ", state.velocity);
      for(var i=0; i<3; ++i) {
        state.position[i] = p[i];
      }
      state.start_tick = tick_count;
      return p;
    },

    getVelocity: function(tick_count, state, r) {
      if(!r) {
        r = [0.0,0.0,0.0];
      }
      var t  = computeTime(tick_count, state),
          a   = [0.0,0.0,0.0],
          mu  = Models.physical.getPhysicalParams(state, a),
          v  = state.velocity;
          
      if(mu < TOLERANCE) {
        for(var i=0; i<3; ++i) {
          r[i] = a[i] * t + v[i];
        }
      }
      else {
        var f = Math.exp(-mu * t),
            u = 1.0/mu;
        for(var i=0; i<3; ++i) {
          r[i] = -((a[i] - v[i]*mu)*f - a[i]) * u;
        }
      }
      return r;
    },
    
    setVelocity: function(tick_count, state, v) {
    
      //console.log("Setting velocity: ", v);
    
      Models.physical.setPosition(tick_count, state, state.position);
      for(var i=0; i<3; ++i) {
        state.velocity[i] = v[i];
      }
      state.start_tick = tick_count;
      return v;
    },
    
    
    getPhysicalParams: function(state, f_total) {

      for(var n in state.forces) {
        var f = state.forces[n];
        for(var i=0; i<3; ++i) {
          f_total[i] += f[i];
        }
      }
      
      //Apply contact constraints and compute friction
      var friction = state.air_friction;
      for(var c in state.contacts) {
        var contact = state.contacts[c],
            nf = 0.0;
         
        for(var i=0; i<3; ++i) {
          nf += f_total[i] * contact[i];
        }
        if(nf > TOLERANCE) {
          continue;
        }
        
        friction -= contact[4] * nf;
        for(var i=0; i<3; ++i) {
          f_total[i] -= nf * contact[i];
        }
      }
      
      //Compute acceleration
      var mass_recip = 1.0/state.mass;
      for(var i=0; i<3; ++i) {
        f_total[i] *= mass_recip;
      }
      
      return friction;
    },
    
    fastForward: function(tick_count, state) {
      Models.physical.getPosition(tick_count, state, state.position);
      Models.physical.getVelocity(tick_count, state, state.velocity);
      
      //console.log("Fast forward velocity: ", state.velocity);

      state.start_tick = tick_count;
    },
    
    params: [
      'model',
      'flags',
      'position',
      'velocity',
      'start_tick',
      'friction',
      'air_friction',
      'forces',
      'contacts',
      'mass',
      'restitution',
    ],
    
    checkDefaults: function(state) {
      Models['linear'].checkDefaults(state);
      if(!state.friction) {
        state.friction = 0.0;
      }
      if(!state.forces) {
        state.forces = {};
      }
      if(!state.contacts) {
        state.contacts = {};
      }
      if(!state.mass) {
        state.mass = 1.0;
      }
      if(!state.restitution) {
        state.restitution = 1.0;
      }
      if(!state.air_friction) {
        state.air_friction = 1.0;
      }
    },
  },
};


//Function for computing position
function getPosition(tick_count, state, r) {
  return Models[state.model].getPosition(tick_count, state, r);
}
function setPosition(tick_count, state, r) {
  return Models[state.model].setPosition(tick_count, state, r);
}
function getVelocity(tick_count, state, r) {
  return Models[state.model].getVelocity(tick_count, state, r);
}
function setVelocity(tick_count, state, r) {
  return Models[state.model].setVelocity(tick_count, state, r);
}
function getMotionParams(state) {
  var params = Models[state.model].params,
      res = {};
  for(var i=0; i<params.length; ++i) {
    res[params[i]] = state[params[i]];
  }
  return res;
}
function setMotionParams(state, motion_params) {
  var params = Models[motion_params.model].params;
  for(var i=0; i<params.length; ++i) {
    state[params[i]] = motion_params[params[i]];
  }
  return state;
}
function fastForward(tick_count, state) {
  if(state.start_tick < tick_count) {
    Models[state.model].fastForward(tick_count, state);
  }
}

//Exports for motion accessors
exports.getPosition     = function(t, s, r) { return getPosition(t, s.motion, r); };
exports.setPosition     = function(t, s, r) { return setPosition(t, s.motion, r); };
exports.getVelocity     = function(t, s, r) { return getVelocity(t, s.motion, r); };
exports.setVelocity     = function(t, s, r) { return setVelocity(t, s.motion, r); }
exports.getMotionParams = function(s) { return getMotionParams(s.motion); }
exports.setMotionParams = function(s) { return setMotionParams(s.motion); }


function applyCollision(tick_count, state1, state2, constraintPlane) {

  var p0    = getPosition(tick_count, state1),
      p1    = getPosition(tick_count+1, state1),
      q0    = getPosition(tick_count, state2),
      q1    = getPosition(tick_count+1, state2);

  //Estimate time of intersection
  var d0 = 0.0, d1 = 0.0;
  for(var i=0; i<3; ++i) {
    d0 += (p0[i] - q0[i]) * constraintPlane[i];
    d1 += (p1[i] - q1[i]) * constraintPlane[i];
  }

  if(Math.abs(d1 + constraintPlane[3]) < STICK_THRESHOLD) {
    console.log("DEGENERATE CASE");
    return COLLIDE_STICK;
  }
  
  //If object doesn't collide, then ignore this
  if((d0 + constraintPlane[3] >= 0 && d1 + constraintPlane[3] >= 0)) {
    return COLLIDE_NONE;
  }
  
  
  //Compute time of impact
  var t = 0.0;
  
  if(Math.abs(d1 - d0) > TOLERANCE) {
    t = 1.0-(constraintPlane[3] + d1) / (d1 - d0);
  }

  console.log("COLLIDING!", d0, d1, t, "p=",p0, p1, "q=",q0, q1, state1.start_tick);

  //Solve for position using linear model :p
  var pt = p1, qt = q1;
  for(var i=0; i<3; ++i) {
    pt[i] = (1.0-t)*p0[i] + t*p1[i];
    qt[i] = (1.0-t)*q0[i] + t*q1[i];
  }
  

  //Clamp t to [0,1]
  t = Math.max(Math.min(t, 1.0), 0.0);

  console.log("pt=", pt, "qt=", qt, "t_clamp=", t);

  
  //Get parameters
  var cr  = Math.min(state1.restitution, state2.restitution),
      vp  = getVelocity(tick_count, state1),
      mp  = state1.mass,
      vq  = getVelocity(tick_count, state2),
      mq  = state2.mass,
      vc  = [0.0,0,0.0,0.0],
      mr  = 1.0 / (mp + mq),
      up  = [0.0,0.0,0.0],
      np  = 0.0,
      uq  = [0.0,0.0,0.0],
      nq  = 0.0;
  
  console.log("cr = ", cr, "vp=", vp, "vq=", vq);
  
  for(var i=0; i<3; ++i) {
    vc[i] =   (mp * vp[i] + mq * vq[i]) * mr;
    up[i] =   vp[i] - vc[i];
    np    +=  up[i] * constraintPlane[i];
    uq[i] =   vq[i] - vc[i];
    nq    +=  uq[i] * constraintPlane[i];
  }
  
  //Check for sticking
  var stick = false;
  console.log("np=", np, "nq=", nq);

  //Check if moving towards separation already
  if(np - nq > 0) {
  
    console.log("MOVING APART");
  
    var delta_p = 0, delta_q = 0;
    for(var i=0; i<3; ++i) {
      delta_p = Math.max(delta_p, Math.abs(pt[i] - p0[i]));
      delta_q = Math.max(delta_q, Math.abs(qt[i] - q0[i]));
    }

    //Only update if we are outside tolerance
    if(delta_p > TOLERANCE) {
      getVelocity(tick_count, state1, state1.velocity);
      state1.start_tick = tick_count;
      state1.position   = pt;
    }
    if(delta_q > TOLERANCE) {
      getVelocity(tick_count, state2, state2.velocity);
      state2.start_tick = tick_count;
      state2.position   = qt;
    }
    
    //Objects are already moving apart
    return COLLIDE_NONE;
  }

  if(Math.abs(np - nq)*cr < STICK_THRESHOLD) {
    console.log("STUCK");
    cr = 0.0;
    stick = true;
  }

  
  //Compute new velocity
  for(var i=0; i<3; ++i) {
    vp[i] = up[i] - (1.0 + cr) * np * constraintPlane[i] + vc[i];
    vq[i] = uq[i] - (1.0 + cr) * nq * constraintPlane[i] + vc[i];
  }
  
  
  var delta_p = 0, delta_q = 0;
  for(var i=0; i<3; ++i) {
    delta_p = Math.max(Math.max(delta_p, 
              Math.abs(pt[i] - p0[i])),
              Math.abs(vp[i] - state1.velocity[i]));
              
    delta_q = Math.max(Math.max(delta_q, 
              Math.abs(qt[i] - q0[i])),
              Math.abs(vq[i] - state2.velocity[i]));
  }
  
  console.log("vpf=", vp, "vqf=", vq);
  
  if(delta_p > TOLERANCE) {
    console.log("updating p");
    state1.start_tick = tick_count;
    state1.position = pt;
    state1.velocity = vp;
  }
  
  if(delta_q > TOLERANCE) {
    console.log("updating q");
    state2.start_tick = tick_count;
    state2.position = qt;
    state2.velocity = vq;
  }
  
  return stick ? COLLIDE_STICK : COLLIDE_BOUNCE;
}



//Registers instance
exports.registerInstance = function(instance) { };

//Adds position, velocity and orientation to entity
exports.registerEntity = function(entity) {

  //Instance reference
  var instance = entity.instance;
  
  //Set initial position/velocity modifiers
  if(!entity.state.motion) {
    entity.state.motion = { model: 'linear' };
  }
  Models[entity.state.motion.model].checkDefaults(entity.state.motion);
  
  //Add getters/setters
  entity.__defineGetter__('position', function() {
    return getPosition(instance.region.tick_count, entity.state.motion);
  });
  entity.__defineSetter__('position', function(p) {
    return setPosition(instance.region.tick_count, entity.state.motion, p);
  });
  entity.__defineGetter__('velocity', function() {
    return getVelocity(instance.region.tick_count, entity.state.motion);
  });
  entity.__defineSetter__('velocity', function(p) {
    return setVelocity(instance.region.tick_count, entity.state.motion, p);
  });
  entity.__defineGetter__('motion_params', function() {
    return getMotionParams(entity.state.motion);
  });
  entity.__defineSetter__('motion_params', function(p) {
    return setMotionParams(entity.state.motion, p);
  });

  entity.setForce = function(force_name, vec) {
    fastForward(instance.region.tick_count, entity.state.motion);
    entity.state.motion.forces[force_name] = vec;
  };
  
  entity.getForce = function(force_name, vec) {
    var f = entity.state.motion.forces[force_name];
    if(f) {
      return f;
    }
    return [0.0,0.0,0.0];
  };
  
  entity.applyImpulse = function(delta_v) {
    var v = getVelocity(instance.region.tick_count, entity.state.motion);
    for(var i=0; i<3; ++i) {
      v[i] += delta_v[i];
    }
    setVelocity(instance.region.tick_count, entity.state.motion, v);
  };

  if(!('gravity' in entity.state.motion.forces)) {
    entity.setForce('gravity', [0,-0.1,0]);
  }
  
  entity.emitter.on('tick', function() {
  
    var res = applyCollision(instance.region.tick_count, entity.state.motion, {
      model: 'constant',
      position: [0,0,0],
      velocity: [0,0,0],
      restitution: 0.5,
      friction: 1.0,
      mass: 10000.0,
    },
    [0, 1, 0, 4]);
    
    if(res !== COLLIDE_STICK) {
      if('level' in entity.state.motion.contacts) {
        delete entity.state.motion.contacts['level'];
      }
    }
    else if(res === COLLIDE_STICK && !('level' in entity.state.motion.contacts)) {
      entity.state.motion.contacts['level'] = [0, 1, 0, 4, 1.0];
    }
  });
};
